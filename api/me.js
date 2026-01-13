// pages/api/me.js
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

    // Verify session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_id, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Get user info
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, avatar_url, created_at, online')
      .eq('id', session.user_id)
      .maybeSingle();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user stats
    const { count: videoCount } = await supabase
      .from('videos')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    const { count: commentCount } = await supabase
      .from('comments')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);

    // Get total likes on user's videos
    const { data: userVideos } = await supabase
      .from('videos')
      .select('id')
      .eq('user_id', user.id);

    let totalLikes = 0;
    if (userVideos && userVideos.length > 0) {
      const videoIds = userVideos.map(v => v.id);
      const { count: likesCount } = await supabase
        .from('likes')
        .select('*', { count: 'exact', head: true })
        .in('video_id', videoIds);
      totalLikes = likesCount || 0;
    }

    return res.status(200).json({
      ...user,
      stats: {
        videos: videoCount || 0,
        comments: commentCount || 0,
        likes: totalLikes,
      }
    });
  } catch (err) {
    console.error('Me API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
