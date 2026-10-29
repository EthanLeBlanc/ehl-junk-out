// EHL Junk Out back end: bookings, quotes, site settings and photos.
// Storage: Netlify Blobs. Admin routes need the ADMIN_PASSWORD environment variable.
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const STATUSES = ["new", "quoted", "accepted", "declined", "done", "cancelled"];
const HOLDS_SLOT = ["new", "quoted", "accepted"];
const WINDOWS = ["8–10 AM", "10–12 PM", "12–2 PM", "2–4 PM"];
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 900 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

const bookingsStore = () => getStore({ name: "bookings", consistency: "strong" });
const siteStore = () => getStore({ name: "site", consistency: "strong" });
const photoStore = () => getStore({ name: "photos", consistency: "strong" });

const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
};
const newId = () => {
  const d = new Date();
  const stamp = d.toISOString().slice(2, 10).replace(/-/g, "");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
};

function isAdmin(req) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null; // not configured
  const given = req.headers.get("x-admin-key") || "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(pw).digest();
  return timingSafeEqual(a, b);
}

function decodeDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) return null;
  return { buf, type: "image/" + m[1] };
}

async function listBookings() {
  const store = bookingsStore();
  const { blobs } = await store.list();
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return all.filter(Boolean).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

// Strip private fields before showing a booking to a customer.
function publicQuote(b) {
  return {
    id: b.id,
    firstName: (b.customer?.name || "").split(" ")[0],
    items: b.items,
    size: b.size,
    date: b.date,
    win: b.win,
    town: b.customer?.addr || "",
    estimate: b.estimate,
    status: b.status,
    quote: b.quote || null,
    response: b.response || null,
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const method = req.method;

  try {
    // ---------- public ----------
    if (path === "/settings" && method === "GET") {
      const s = await siteStore().get("settings", { type: "json" });
      return s ? json(s) : fail(404, "No saved settings yet");
    }

    if (path === "/slots" && method === "GET") {
      const date = str(url.searchParams.get("date"), 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, "Bad date");
      const all = await listBookings();
      const taken = all.filter((b) => b.date === date && HOLDS_SLOT.includes(b.status)).map((b) => b.win);
      return json({ taken: [...new Set(taken)] });
    }

    if (path === "/bookings" && method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body) return fail(400, "Bad request");
      // Bot check: nobody finishes all four booking steps in under 3 seconds.
      if (typeof body.elapsed === "number" && body.elapsed < 3000) return fail(400, "Please take a moment to fill in the form, then try again.");
      const name = str(body.name, 80), phone = str(body.phone, 30), addr = str(body.addr, 200);
      const email = str(body.email, 120);
      const date = str(body.date, 10), win = str(body.win, 20);
      if (!name || phone.replace(/\D/g, "").length < 10 || !addr) return fail(400, "Name, phone and address are required");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !WINDOWS.includes(win)) return fail(400, "Pick a day and arrival window");
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "That email address doesn't look right");

      const all = await listBookings();
      if (all.some((b) => b.date === date && b.win === win && HOLDS_SLOT.includes(b.status)))
        return fail(409, "That time was just booked by someone else. Pick another window.");

      const id = newId();
      const photos = [];
      for (const p of (Array.isArray(body.photos) ? body.photos : []).slice(0, MAX_PHOTOS)) {
        const d = decodeDataUrl(p);
        if (!d) continue;
        const key = `c/${id}/${photos.length}`;
        await photoStore().set(key, d.buf, { metadata: { type: d.type } });
        photos.push(key);
      }
      const booking = {
        id,
        token: randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
        status: "new",
        customer: { name, phone, email, addr },
        items: (Array.isArray(body.items) ? body.items : []).map((i) => str(i, 40)).filter(Boolean).slice(0, 12),
        size: str(body.size, 60),
        estimate: num(body.estimate),
        date, win,
        notes: str(body.notes, 1000),
        photos,
        quote: null,
        response: null,
        internalNote: "",
        finalPrice: null,
        history: [{ at: new Date().toISOString(), what: "Booked online" }],
      };
      await bookingsStore().setJSON(id, booking);
      return json({ ok: true, id });
    }

    if (path === "/quote" && method === "GET") {
      const b = await bookingsStore().get(str(url.searchParams.get("id"), 40), { type: "json" });
      if (!b || b.token !== url.searchParams.get("k")) return fail(404, "Quote not found");
      return json(publicQuote(b));
    }

    if (path === "/quote/respond" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const store = bookingsStore();
      const b = await store.get(str(body.id, 40), { type: "json" });
      if (!b || b.token !== body.k) return fail(404, "Quote not found");
      if (!b.quote) return fail(400, "No quote has been sent yet");
      if (!["quoted", "accepted", "declined"].includes(b.status)) return fail(400, "This quote can't be changed anymore");
      const accept = body.accept === true;
      b.status = accept ? "accepted" : "declined";
      b.response = { accepted: accept, note: str(body.note, 500), at: new Date().toISOString() };
      b.history = [...(b.history || []), { at: b.response.at, what: accept ? "Customer accepted quote" : "Customer declined quote" }];
      await store.setJSON(b.id, b);
      return json(publicQuote(b));
    }

    if (path === "/photo" && method === "GET") {
      const key = str(url.searchParams.get("key"), 80);
      if (!/^(g\/[a-f0-9]{16}|c\/[\w-]+\/\d)$/.test(key)) return fail(400, "Bad key");
      if (key.startsWith("c/") && isAdmin(req) !== true) return fail(401, "Admin only");
      const res = await photoStore().getWithMetadata(key, { type: "arrayBuffer" });
      if (!res) return fail(404, "Not found");
      return new Response(res.data, {
        headers: {
          "content-type": res.metadata?.type || "image/jpeg",
          "cache-control": key.startsWith("g/") ? "public, max-age=31536000, immutable" : "private, no-store",
        },
      });
    }

    // ---------- admin ----------
    if (path.startsWith("/admin/")) {
      const ok = isAdmin(req);
      if (ok === null) return fail(503, "Admin password isn't set up yet. Add ADMIN_PASSWORD in Netlify.");
      if (!ok) return fail(401, "Wrong password");

      if (path === "/admin/check") return json({ ok: true });

      if (path === "/admin/bookings" && method === "GET") return json(await listBookings());

      if (path === "/admin/bookings" && method === "PATCH") {
        const body = await req.json().catch(() => ({}));
        const store = bookingsStore();
        const b = await store.get(str(body.id, 40), { type: "json" });
        if (!b) return fail(404, "Booking not found");
        const now = new Date().toISOString();
        const log = (what) => (b.history = [...(b.history || []), { at: now, what }]);
        if (body.quote) {
          const amount = num(body.quote.amount);
          if (amount === null) return fail(400, "Enter a quote amount");
          b.quote = { amount, message: str(body.quote.message, 1000), sentAt: now };
          b.response = null;
          if (["new", "quoted", "declined", "accepted"].includes(b.status)) b.status = "quoted";
          log(`Quote sent: $${amount}`);
        }
        if (body.status && body.status !== b.status) {
          if (!STATUSES.includes(body.status)) return fail(400, "Unknown status");
          log(`Status: ${b.status} → ${body.status}`);
          b.status = body.status;
          if (b.status === "done") b.doneAt = now; else delete b.doneAt;
        }
        if (body.status === "done" && b.status === "done" && !b.doneAt) b.doneAt = now;
        if ("internalNote" in body) b.internalNote = str(body.internalNote, 2000);
        if ("finalPrice" in body) b.finalPrice = body.finalPrice === "" || body.finalPrice === null ? null : num(body.finalPrice);
        if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) && body.date !== b.date) { log(`Moved to ${body.date}`); b.date = body.date; }
        if (body.win && WINDOWS.includes(body.win) && body.win !== b.win) { log(`Window: ${body.win}`); b.win = body.win; }
        await store.setJSON(b.id, b);
        return json(b);
      }

      if (path === "/admin/bookings" && method === "DELETE") {
        const id = str(url.searchParams.get("id"), 40);
        const b = await bookingsStore().get(id, { type: "json" });
        if (!b) return fail(404, "Booking not found");
        for (const k of b.photos || []) await photoStore().delete(k);
        await bookingsStore().delete(id);
        return json({ ok: true });
      }

      if (path === "/admin/settings" && method === "GET") {
        return json((await siteStore().get("settings", { type: "json" })) || null);
      }

      if (path === "/admin/settings" && method === "PUT") {
        const s = await req.json().catch(() => null);
        if (!s || !Array.isArray(s.loads) || !Array.isArray(s.extras) || !s.area || !s.about) return fail(400, "Settings look incomplete");
        s.updated = new Date().toISOString().slice(0, 10);
        if (JSON.stringify(s).length > 100000) return fail(400, "Settings are too large");
        await siteStore().setJSON("settings", s);
        return json(s);
      }

      if (path === "/admin/photo" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const d = decodeDataUrl(body.dataUrl);
        if (!d) return fail(400, "That photo couldn't be read. Try a JPG or PNG.");
        const key = "g/" + randomBytes(8).toString("hex");
        await photoStore().set(key, d.buf, { metadata: { type: d.type } });
        return json({ key });
      }

      if (path === "/admin/photo" && method === "DELETE") {
        const key = str(url.searchParams.get("key"), 40);
        if (!/^g\/[a-f0-9]{16}$/.test(key)) return fail(400, "Bad key");
        await photoStore().delete(key);
        return json({ ok: true });
      }
    }

    return fail(404, "Not found");
  } catch (err) {
    console.error(err);
    return fail(500, "Something went wrong on our end. Try again.");
  }
};

export const config = { path: "/api/*" };
