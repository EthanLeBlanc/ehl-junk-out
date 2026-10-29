# EHL Junk Out

Website for EHL Junk Out junk removal. Live at https://ehljunkout.netlify.app

- `public/index.html`: the customer website
- `public/admin.html`: owner admin (bookings, quotes, website settings). Needs the `ADMIN_PASSWORD` environment variable in Netlify.
- `public/quote.html`: the page customers open from a quote link
- `netlify/functions/api.mjs`: the back end. Data is stored in Netlify Blobs.
