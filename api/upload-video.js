// pages/api/upload-video.js - FIXED VERSION with busboy
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';
import { v4 as uuidv4 } from 'uuid';
import Busboy from 'busboy';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

export const config = {
  api: {
    bodyParser: false, // Disable default bodyParser to handle multipart manually
  },
};

export default async function handler(req, res) {
  console.log('=== UPLOAD VIDEO API CALLED ===');

  // Set CORS headers (must be set before any response)
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    console.log('✅ CORS preflight request');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    console.error('❌ Method not allowed:', req.method);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // 1. Verify session (same as your original code)
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    if (!sessionToken) {
      console.error('❌ No session token found');
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session) {
      console.error('❌ Session error:', sessionError);
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    if (new Date(session.expires_at) < new Date()) {
      console.error('❌ Session expired');
      await supabase.from('sessions').delete().eq('session_token', sessionToken);
      return res.status(401).json({ success: false, error: 'Session expired' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, video_count')
      .eq('email', session.user_email)
      .maybeSingle();

    if (userError || !user) {
      console.error('❌ User error:', userError);
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    console.log('✅ User authenticated:', user.email, 'ID:', user.id);
    const userId = user.id;

    // 2. Parse multipart form data using busboy
    const formData = await parseMultipartFormData(req);

    // 3. Validate required fields
    if (!formData.video || !formData.video.buffer) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }

    if (!formData.title || formData.title.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Title must be at least 3 characters' });
    }

    // 4. Process settings JSON if present (sent by frontend)
    let settings = {};
    if (formData.settings) {
      try {
        settings = JSON.parse(formData.settings);
      } catch (e) {
        console.warn('⚠️ Invalid settings JSON, ignoring');
      }
    }

    // 5. Upload video to Supabase storage
    const videoId = uuidv4();
    const videoExt = formData.video.filename.split('.').pop().toLowerCase();
    const videoName = `${userId}/${videoId}.${videoExt}`;

    const { error: videoUploadError } = await supabase.storage
      .from('videos')
      .upload(videoName, formData.video.buffer, {
        contentType: formData.video.mimeType,
        cacheControl: 'public, max-age=31536000',
      });

    if (videoUploadError) {
      console.error('❌ Video upload failed:', videoUploadError);
      return res.status(500).json({ success: false, error: 'Failed to upload video' });
    }

    const { data: videoUrlData } = supabase.storage.from('videos').getPublicUrl(videoName);

    // 6. Optional cover image upload
    let coverUrl = null;
    if (formData.cover && formData.cover.buffer) {
      const coverExt = formData.cover.filename.split('.').pop().toLowerCase();
      const coverName = `${userId}/${videoId}.${coverExt}`;

      const { error: coverUploadError } = await supabase.storage
        .from('covers')
        .upload(coverName, formData.cover.buffer, {
          contentType: formData.cover.mimeType,
          cacheControl: 'public, max-age=31536000',
        });

      if (!coverUploadError) {
        const { data: coverUrlData } = supabase.storage.from('covers').getPublicUrl(coverName);
        coverUrl = coverUrlData.publicUrl;
      } else {
        console.warn('⚠️ Cover upload failed:', coverUploadError);
      }
    }

    // 7. Create video record in database
    const videoData = {
      id: videoId,
      user_id: userId,
      title: formData.title.trim(),
      description: formData.description?.trim() || null,
      video_url: videoUrlData.publicUrl,
      cover_url: coverUrl,
      mime_type: formData.video.mimeType,
      size: formData.video.buffer.length,
      original_filename: formData.video.filename,
      tags: formData.tags ? formData.tags.split(',').map(tag => tag.trim()).filter(tag => tag) : [],
      category: formData.category || 'other',
      privacy: formData.privacy || 'public',
      ai_generated: settings.aiGenerated || false,
      allow_comments: settings.allowComments ?? true,
      allow_ratings: settings.allowRatings ?? true,
      show_view_count: settings.showViewCount ?? true,
      created_at: new Date().toISOString(),
      uploaded_at: new Date().toISOString(),
    };

    const { data: video, error: dbError } = await supabase
      .from('videos')
      .insert(videoData)
      .select()
      .single();

    if (dbError) {
      console.error('❌ Database insert failed:', dbError);
      // Clean up uploaded files
      await supabase.storage.from('videos').remove([videoName]);
      if (coverUrl) {
        const coverName = `${userId}/${videoId}.${formData.cover.filename.split('.').pop().toLowerCase()}`;
        await supabase.storage.from('covers').remove([coverName]);
      }
      return res.status(500).json({ success: false, error: 'Failed to save video metadata' });
    }

    // 8. Update user's video count
    await supabase
      .from('users')
      .update({
        video_count: (user.video_count || 0) + 1,
        last_upload: new Date().toISOString(),
      })
      .eq('id', userId);

    console.log('✅ Upload completed successfully!');
    return res.status(200).json({
      success: true,
      message: 'Video uploaded successfully',
      video: {
        ...video,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      },
    });
  } catch (err) {
    console.error('❌❌❌ UPLOAD HANDLER FATAL ERROR:', err);
    console.error('❌❌❌ Error stack:', err.stack);
    return res.status(500).json({
      success: false,
      error: 'Internal server error: ' + err.message,
    });
  }
}

/**
 * Parse multipart/form-data using busboy
 */
function parseMultipartFormData(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: MAX_FILE_SIZE,
        fields: 20, // max number of non-file fields
      },
    });

    const formData = {};

    busboy.on('file', (fieldname, file, info) => {
      const { filename, mimeType } = info;
      const chunks = [];

      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        formData[fieldname] = {
          filename,
          mimeType,
          buffer: Buffer.concat(chunks),
        };
      });
      file.on('error', reject);
    });

    busboy.on('field', (fieldname, value) => {
      // Trim string values (optional)
      formData[fieldname] = typeof value === 'string' ? value.trim() : value;
    });

    busboy.on('error', reject);
    busboy.on('finish', () => resolve(formData));

    // Pipe the raw request into busboy
    req.pipe(busboy);
  });
}
