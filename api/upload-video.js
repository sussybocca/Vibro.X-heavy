// pages/api/upload-video.js - FIXED VERSION
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

export default async function handler(req, res) {
  console.log('=== UPLOAD VIDEO API CALLED ===');
  
  // Set CORS headers
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
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    if (!sessionToken) {
      console.error('❌ No session token found');
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session
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

    // Get user
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
    
    // Parse form data
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      // Handle multipart/form-data upload
      const formData = await parseMultipartFormData(req);
      
      if (!formData.video || !formData.video.buffer) {
        return res.status(400).json({ success: false, error: 'No video file provided' });
      }
      
      if (!formData.title || formData.title.trim().length < 3) {
        return res.status(400).json({ success: false, error: 'Title must be at least 3 characters' });
      }
      
      // Generate unique ID
      const videoId = uuidv4();
      const videoExt = formData.video.filename.split('.').pop().toLowerCase();
      const videoName = `${userId}/${videoId}.${videoExt}`;
      
      // Upload video to storage
      const { error: videoUploadError } = await supabase.storage
        .from('videos')
        .upload(videoName, formData.video.buffer, {
          contentType: formData.video.mimeType,
          cacheControl: 'public, max-age=31536000'
        });
      
      if (videoUploadError) {
        console.error('❌ Video upload failed:', videoUploadError);
        return res.status(500).json({ success: false, error: 'Failed to upload video' });
      }
      
      // Get video URL
      const { data: videoUrlData } = supabase.storage
        .from('videos')
        .getPublicUrl(videoName);
      
      let coverUrl = null;
      // Handle cover image if provided
      if (formData.cover && formData.cover.buffer) {
        const coverExt = formData.cover.filename.split('.').pop().toLowerCase();
        const coverName = `${userId}/${videoId}.${coverExt}`;
        
        const { error: coverUploadError } = await supabase.storage
          .from('covers')
          .upload(coverName, formData.cover.buffer, {
            contentType: formData.cover.mimeType,
            cacheControl: 'public, max-age=31536000'
          });
        
        if (!coverUploadError) {
          const { data: coverUrlData } = supabase.storage
            .from('covers')
            .getPublicUrl(coverName);
          coverUrl = coverUrlData.publicUrl;
        }
      }
      
      // Create video record
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
        ai_generated: formData.aiGenerated === 'true',
        created_at: new Date().toISOString(),
        uploaded_at: new Date().toISOString()
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
      
      // Update user's video count
      await supabase
        .from('users')
        .update({ 
          video_count: (user.video_count || 0) + 1,
          last_upload: new Date().toISOString()
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
            email: user.email
          }
        }
      });
      
    } else {
      console.error('❌ Unsupported Content-Type:', contentType);
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported Content-Type. Use multipart/form-data' 
      });
    }
    
  } catch (err) {
    console.error('❌❌❌ UPLOAD HANDLER FATAL ERROR:', err);
    console.error('❌❌❌ Error stack:', err.stack);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error: ' + err.message
    });
  }
}

// Helper function to parse multipart form data
async function parseMultipartFormData(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const parts = buffer.toString('binary').split(`--${boundary}`);
        
        const formData = {};
        
        for (const part of parts) {
          if (part.includes('Content-Disposition')) {
            const headersEnd = part.indexOf('\r\n\r\n');
            const headers = part.substring(0, headersEnd);
            const body = part.substring(headersEnd + 4, part.length - 2);
            
            const nameMatch = headers.match(/name="([^"]+)"/);
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            const contentTypeMatch = headers.match(/Content-Type: ([^\r\n]+)/);
            
            if (nameMatch) {
              const name = nameMatch[1];
              
              if (filenameMatch) {
                // This is a file
                const filename = filenameMatch[1];
                const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
                const fileBuffer = Buffer.from(body, 'binary');
                
                formData[name] = {
                  filename,
                  mimeType: contentType,
                  buffer: fileBuffer
                };
              } else {
                // This is a regular field
                formData[name] = body;
              }
            }
          }
        }
        
        resolve(formData);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
