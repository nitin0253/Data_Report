// api/auth-config.js — public endpoint returning the Google Client ID
// No secrets exposed — only the client ID which is inherently public.

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    clientId: process.env.GOOGLE_CLIENT_ID || '',
  });
}
