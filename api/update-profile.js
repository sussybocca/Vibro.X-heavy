// pages/api/update-profile.js
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'];

    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { data: session } = await supabase
      .from('sessions')
      .select('user_id, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    const userId = session.user_id;

    // Parse multipart form data for avatar upload
    const Busboy = require('busboy');
    const busboy = Busboy({ headers: req.headers });

    let avatarBuffer = null;
    let avatarFilename = '';
    let username = '';
    let bio = '';

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'username') username = val.trim();
      if (fieldname === 'bio') bio = val.trim();
    });

    busboy.on('file', async (fieldname, file, info) => {
      if (fieldname === 'avatar') {
        const chunks = [];
        file.on('data', (chunk) => {
          chunks.push(chunk);
        });
        file.on('end', async () => {
          avatarBuffer = Buffer.concat(chunks);
          avatarFilename = `avatars/${userId}_${Date.now()}_${info.filename.replace(/[^a-z0-9._-]/gi, '_')}`;
        });
      }
    });

    busboy.on('finish', async () => {
      try {
        const updates = {};

        // Update username if provided
        if (username) {
          // Check if username is available
          const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('username', username)
            .neq('id', userId)
            .maybeSingle();

          if (existingUser) {
            return res.status(400).json({ error: 'Username already taken' });
          }
          updates.username = username;
        }

        // Update bio if provided
        if (bio !== undefined) {
          updates.bio = bio;
        }

        // Upload avatar if provided
        if (avatarBuffer) {
          // Delete old avatar if exists
          const { data: user } = await supabase
            .from('users')
            .select('avatar_url')
            .eq('id', userId)
            .maybeSingle();

          if (user?.avatar_url) {
            await supabase.storage
              .from('avatars')
              .remove([user.avatar_url]);
          }

          // Upload new avatar
          const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(avatarFilename, avatarBuffer, {
              contentType: 'image/jpeg',
              upsert: false
            });

          if (uploadError) {
            console.error('Avatar upload failed:', uploadError);
            return res.status(500).json({ error: 'Failed to upload avatar' });
          }

          updates.avatar_url = avatarFilename;
        }

        // Update user in database
        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await supabase
            .from('users')
            .update(updates)
            .eq('id', userId);

          if (updateError) {
            console.error('Profile update failed:', updateError);
            return res.status(500).json({ error: 'Failed to update profile' });
          }
        }

        // Get updated user data
        const { data: updatedUser } = await supabase
          .from('users')
          .select('id, email, username, avatar_url, bio, created_at, online')
          .eq('id', userId)
          .maybeSingle();

        return res.status(200).json({
          success: true,
          message: 'Profile updated successfully',
          user: updatedUser
        });

      } catch (err) {
        console.error('Profile update error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    });

    req.pipe(busboy);

  } catch (err) {
    console.error('Profile API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
