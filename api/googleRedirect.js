// /api/googleRedirect.js
export default function handler(req, res) {
  try {
    // 1️⃣ Get Google Client ID and your site URL from environment
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error('Missing GOOGLE_CLIENT_ID');

    const redirectUri = `${process.env.SITE_URL}/api/googleCallback`; // Must match Google OAuth redirect URI
    if (!process.env.SITE_URL) throw new Error('Missing SITE_URL');

    // 2️⃣ OAuth scopes
    const scope = encodeURIComponent('openid email profile');

    // 3️⃣ Build auth URL
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${scope}` +
      `&prompt=consent` +
      `&access_type=offline`;

    // 4️⃣ Redirect user to Google OAuth
    return res.redirect(authUrl);

  } catch (err) {
    console.error('Google Redirect Error:', err);
    return res.status(500).json({ success: false, error: 'Failed to initiate Google login', details: err.message });
  }
}
