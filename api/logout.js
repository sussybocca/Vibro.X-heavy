// pages/api/logout.js
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'];

    if (!sessionToken) {
      return res.status(200).json({ success: true, message: 'Already logged out' });
    }

    // Delete session from database
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('session_token', sessionToken);

    if (error) {
      console.error('Logout error:', error);
    }

    // Clear cookie
    res.setHeader('Set-Cookie', cookie.serialize('__Host-session_secure', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 0, // Expire immediately
      path: '/'
    }));

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err) {
    console.error('Logout API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
