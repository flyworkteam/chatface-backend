/**
 * internalAuth.js
 *
 * Protects /api/ai/internal/* routes that receive callbacks from n8n.
 * Requests must supply the INTERNAL_API_SECRET header value.
 * In production, also restrict to the n8n VPS IP via N8N_VPS_IP env var.
 */

const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';
const N8N_VPS_IP = process.env.N8N_VPS_IP || ''; // optional extra IP allowlist

const requireInternalAuth = (req, res, next) => {
  // 1. Secret header check
  const provided = req.headers['x-internal-secret'] || '';
  if (!INTERNAL_SECRET || provided !== INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2. Optional IP allowlist (set N8N_VPS_IP to the private IP of your n8n VPS)
  if (N8N_VPS_IP) {
    const clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      '';
    const allowed = N8N_VPS_IP.split(',').map((s) => s.trim());
    if (!allowed.includes(clientIp)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  next();
};

module.exports = { requireInternalAuth };
