import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');

    const redirectUri = `${process.env.SITE_URL}`;

    // Exchange code for token
    const params = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(401).send('Google auth failed');

    // Get Google profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    const googleId = profile.id;
    const googleEmail = profile.email;

    // Find user by Google ID
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('google_id', googleId)
      .single();

    // Link by email if Google ID not found
    if (!user) {
      const { data: emailUser } = await supabase
        .from('users')
        .select('*')
        .eq('email', googleEmail)
        .single();

      if (!emailUser || !emailUser.verified) {
        return res.status(403).send('Account not verified or not approved');
      }

      // Link Google account
      await supabase
        .from('users')
        .update({ google_id: googleId, google_email: googleEmail, google_linked: true })
        .eq('email', googleEmail);

      user = emailUser;
    }

    // Create session
    const session_token = uuidv4();
    const expiresInDays = 7;

    await supabase.from('sessions').insert({
      user_email: user.email,
      session_token,
      expires_at: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    });

    // Set cookie and redirect
    res.setHeader(
      'Set-Cookie',
      `session_token=${session_token}; Path=/; Max-Age=${expiresInDays * 24 * 60 * 60}; SameSite=Lax`
    );

    return res.redirect('/index.html');
  } catch (err) {
    console.error('Google callback error:', err);
    return res.status(500).send('Internal server error');
  }
}
