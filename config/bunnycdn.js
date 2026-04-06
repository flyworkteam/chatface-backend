require("dotenv").config();

/**
 * BunnyCDN Storage config
 * Required env vars:
 * - BUNNY_STORAGE_ZONE: storage zone name (used in storage URL)
 * - BUNNY_API_KEY: storage access key
 * - BUNNY_CDN_BASE_URL: base delivery URL (e.g. https://<yourpullzone>.b-cdn.net)
 */
module.exports = {
  storageZone: process.env.BUNNY_STORAGE_ZONE,
  apiKey: process.env.BUNNY_API_KEY,
  cdnBaseUrl: process.env.BUNNY_CDN_BASE_URL,
};
