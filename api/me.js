import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Get session from database
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_id, user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Get user info
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, avatar_url, created_at, online, video_count, bio, location')
      .eq('id', session.user_id)
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json({
      id: user.id,
      email: user.email,
      username: user.username,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      online: user.online,
      video_count: user.video_count || 0,
      bio: user.bio,
      location: user.location
    });
  } catch (err) {
    console.error('Me API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
