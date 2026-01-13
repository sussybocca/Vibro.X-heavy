import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Set CORS headers for Vercel
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Parse cookies
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    if (!sessionToken) {
      console.log('No session token found in cookies');
      return res.status(401).json({ 
        success: false, 
        authenticated: false,
        error: 'Not authenticated. No session token found.' 
      });
    }

    console.log('Session token found, validating:', sessionToken.substring(0, 20) + '...');

    // Get session from database with user info
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select(`
        *,
        users:user_id (
          id,
          email,
          username,
          profile_picture,
          created_at,
          online,
          bio,
          completed_profile,
          last_online,
          verified,
          google_linked,
          fbx_avatar_ids,
          suspended,
          suspension_reason
        )
      `)
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError) {
      console.error('Session query error:', sessionError);
      return res.status(500).json({ 
        success: false, 
        authenticated: false,
        error: 'Error validating session' 
      });
    }

    if (!session) {
      console.log('Session not found in database');
      return res.status(401).json({ 
        success: false, 
        authenticated: false,
        error: 'Session not found or invalid' 
      });
    }

    // Check if session is expired
    if (new Date(session.expires_at) < new Date()) {
      console.log('Session expired:', session.expires_at);
      
      // Clean up expired session
      await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken);
        
      return res.status(401).json({ 
        success: false, 
        authenticated: false,
        error: 'Session expired. Please login again.' 
      });
    }

    // Check if user is suspended
    if (session.users?.suspended) {
      console.log('User is suspended:', session.users.email);
      return res.status(403).json({ 
        success: false, 
        authenticated: true,
        user: {
          id: session.users.id,
          email: session.users.email,
          username: session.users.username,
          suspended: true,
          suspension_reason: session.users.suspension_reason
        },
        error: 'Account suspended: ' + (session.users.suspension_reason || 'Contact support')
      });
    }

    // Update user's online status and last_online
    await supabase
      .from('users')
      .update({ 
        online: true,
        last_online: new Date().toISOString()
      })
      .eq('id', session.user_id);

    // Return user data based on your actual schema
    const userData = {
      id: session.users?.id || session.user_id,
      email: session.users?.email || session.user_email,
      username: session.users?.username,
      profile_picture: session.users?.profile_picture,
      avatar_url: session.users?.profile_picture, // Alias for compatibility
      created_at: session.users?.created_at,
      online: true, // Force online since they just authenticated
      bio: session.users?.bio,
      verified: session.users?.verified,
      completed_profile: session.users?.completed_profile,
      last_online: session.users?.last_online,
      google_linked: session.users?.google_linked,
      fbx_avatar_ids: session.users?.fbx_avatar_ids,
      suspended: session.users?.suspended || false,
      session_expires: session.expires_at
    };

    console.log('Session validated for user:', userData.email);

    return res.status(200).json({
      success: true,
      authenticated: true,
      user: userData,
      session: {
        expires_at: session.expires_at,
        created_at: session.created_at
      }
    });

  } catch (err) {
    console.error('Me API error:', err);
    return res.status(500).json({ 
      success: false, 
      authenticated: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
