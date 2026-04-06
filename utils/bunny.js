const axios = require("axios");
const { storageZone, apiKey, cdnBaseUrl } = require("../config/bunnycdn");

/**
 * Uploads a buffer to BunnyCDN Storage and returns the public URL.
 * @param {Buffer} buffer
 * @param {String} destPath - path inside storage zone, e.g. "profiles/3_1680000000.jpg"
 * @param {String} contentType
 * @returns {String} public URL
 */
const uploadBuffer = async (buffer, destPath, contentType) => {
  if (!storageZone || !apiKey) {
    throw new Error("BunnyCDN storageZone or apiKey not configured");
  }

  // Storage API endpoint
  const url = `https://storage.bunnycdn.com/${storageZone}/${destPath}`;

  const headers = {
    AccessKey: apiKey,
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": buffer.length,
  };

  await axios.put(url, buffer, { headers });

  // Construct public URL using provided cdnBaseUrl if available, otherwise fallback to storage URL
  if (cdnBaseUrl) {
    const normalizedBase = /^https?:\/\//i.test(cdnBaseUrl)
      ? cdnBaseUrl
      : `https://${cdnBaseUrl}`;
    const base = normalizedBase.replace(/\/$/, "");
    return `${base}/${destPath}`;
  }

  return `https://storage.bunnycdn.com/${storageZone}/${destPath}`;
};

module.exports = {
  uploadBuffer,
};
