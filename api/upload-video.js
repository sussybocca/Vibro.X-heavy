// pages/api/upload-video.js
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';
import { v4 as uuidv4 } from 'uuid';
import busboy from 'busboy';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB (larger for videos)
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/mov',
  'video/avi',
  'video/mkv'
];
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/jpg'
];

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '500mb'
  },
};

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    console.log('🔍 Video upload - Session found:', !!sessionToken);

    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session with user_email
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session) {
      console.error('Session error:', sessionError);
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    // Check if session is expired
    if (new Date(session.expires_at) < new Date()) {
      await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken);
      return res.status(401).json({ success: false, error: 'Session expired' });
    }

    // Get user by email
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username, video_count')
      .eq('email', session.user_email)
      .maybeSingle();

    if (userError || !user) {
      console.error('User error:', userError);
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const userId = user.id;
    const userEmail = user.email;
    console.log('👤 User uploading video:', { userId, username: user.username });

    // Parse multipart form data
    return new Promise((resolve) => {
      const bb = busboy({
        headers: req.headers,
        limits: {
          fileSize: MAX_FILE_SIZE,
          files: 2
        }
      });

      let videoFile = null;
      let coverFile = null;
      let videoTitle = '';
      let description = '';
      let tags = '';
      let vibeId = null;
      let aiGenerated = false;

      bb.on('field', (name, value) => {
        console.log(`📝 Field ${name}: ${value.substring(0, 50)}...`);
        if (name === 'title') videoTitle = value.trim();
        if (name === 'description') description = value.trim();
        if (name === 'tags') tags = value.trim();
        if (name === 'vibeId') vibeId = value.trim();
        if (name === 'aiGenerated') aiGenerated = value === 'true';
      });

      bb.on('file', (name, file, info) => {
        const { filename, mimeType, encoding } = info;
        console.log(`📁 File ${name}: ${filename} (${mimeType}, ${encoding})`);
        
        const chunks = [];
        
        file.on('data', (chunk) => {
          chunks.push(chunk);
        });

        file.on('end', () => {
          const buffer = Buffer.concat(chunks);
          
          if (name === 'video') {
            if (!ALLOWED_VIDEO_TYPES.includes(mimeType)) {
              file.resume(); // Drain the file stream
              resolve(res.status(400).json({ 
                success: false, 
                error: `Invalid video format: ${mimeType}. Allowed: ${ALLOWED_VIDEO_TYPES.join(', ')}` 
              }));
              return;
            }
            
            if (buffer.length > MAX_FILE_SIZE) {
              file.resume();
              resolve(res.status(400).json({ 
                success: false, 
                error: `Video too large: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB. Max: ${MAX_FILE_SIZE / (1024 * 1024)}MB` 
              }));
              return;
            }
            
            videoFile = {
              buffer,
              filename,
              mimeType,
              size: buffer.length
            };
            console.log(`✅ Video file ready: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB`);
            
          } else if (name === 'cover') {
            if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
              file.resume();
              resolve(res.status(400).json({ 
                success: false, 
                error: `Invalid image format: ${mimeType}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}` 
              }));
              return;
            }
            
            coverFile = {
              buffer,
              filename,
              mimeType,
              size: buffer.length
            };
            console.log(`✅ Cover image ready: ${(buffer.length / 1024).toFixed(2)}KB`);
          }
        });

        file.on('error', (err) => {
          console.error('File stream error:', err);
          file.resume();
          resolve(res.status(500).json({ 
            success: false, 
            error: 'File upload failed' 
          }));
        });
      });

      bb.on('finish', async () => {
        try {
          console.log('🎬 Processing upload...');
          
          // Validate required fields
          if (!videoFile) {
            return resolve(res.status(400).json({ 
              success: false, 
              error: 'No video uploaded' 
            }));
          }
          
          if (!coverFile) {
            console.log('⚠️ No cover image provided, using default');
            // You could generate a thumbnail from the video here
            // For now, we'll make cover optional
          }
          
          if (!videoTitle || videoTitle.length < 3) {
            return resolve(res.status(400).json({ 
              success: false, 
              error: 'Video title must be at least 3 characters' 
            }));
          }

          // Generate unique filenames
          const videoId = uuidv4();
          const videoExt = videoFile.filename.split('.').pop().toLowerCase();
          const videoName = `${userId}/${videoId}.${videoExt}`;
          
          let coverName = null;
          if (coverFile) {
            const coverExt = coverFile.filename.split('.').pop().toLowerCase();
            coverName = `${userId}/${videoId}.${coverExt}`;
          }

          // 1. Upload video to storage
          console.log('⬆️ Uploading video to storage...');
          const { error: videoUploadError } = await supabase.storage
            .from('videos')
            .upload(videoName, videoFile.buffer, {
              contentType: videoFile.mimeType,
              cacheControl: 'public, max-age=31536000',
              upsert: false
            });

          if (videoUploadError) {
            console.error('❌ Video upload failed:', videoUploadError);
            return resolve(res.status(500).json({ 
              success: false, 
              error: 'Failed to upload video to storage' 
            }));
          }
          console.log('✅ Video uploaded to storage');

          // 2. Upload cover if provided
          if (coverFile) {
            console.log('⬆️ Uploading cover image...');
            const { error: coverUploadError } = await supabase.storage
              .from('covers')
              .upload(coverName, coverFile.buffer, {
                contentType: coverFile.mimeType,
                cacheControl: 'public, max-age=31536000',
                upsert: false
              });

            if (coverUploadError) {
              console.error('❌ Cover upload failed:', coverUploadError);
              // Clean up video
              await supabase.storage.from('videos').remove([videoName]);
              return resolve(res.status(500).json({ 
                success: false, 
                error: 'Failed to upload cover image' 
              }));
            }
            console.log('✅ Cover image uploaded');
          }

          // Get public URLs
          const { data: videoUrlData } = supabase.storage
            .from('videos')
            .getPublicUrl(videoName);
            
          const videoPublicUrl = videoUrlData.publicUrl;
          
          let coverPublicUrl = null;
          if (coverName) {
            const { data: coverUrlData } = supabase.storage
              .from('covers')
              .getPublicUrl(coverName);
            coverPublicUrl = coverUrlData.publicUrl;
          }

          // 3. Create video record in database
          console.log('💾 Saving video metadata to database...');
          
          // Parse tags if provided
          let tagsArray = [];
          if (tags) {
            tagsArray = tags.split(',')
              .map(tag => tag.trim())
              .filter(tag => tag.length > 0)
              .slice(0, 10); // Limit to 10 tags
          }

          // Verify vibe exists if provided
          if (vibeId) {
            const { data: vibe } = await supabase
              .from('vibes')
              .select('id')
              .eq('id', vibeId)
              .maybeSingle();
            
            if (!vibe) {
              console.warn(`⚠️ Vibe ${vibeId} not found, ignoring`);
              vibeId = null;
            }
          }

          // Insert video - matches your schema
          const videoData = {
            id: videoId,
            user_id: userId,
            title: videoTitle,
            description: description || null,
            video_url: videoPublicUrl, // Store the public URL
            url: videoPublicUrl, // Also store in url field for compatibility
            cover_url: coverPublicUrl,
            mime_type: videoFile.mimeType,
            size: videoFile.size,
            original_filename: videoFile.filename,
            views: 0,
            tags: tagsArray,
            ai_generated: aiGenerated || false,
            created_at: new Date().toISOString()
          };

          // Add vibe_id if provided
          if (vibeId) {
            videoData.vibe_id = vibeId;
          }

          const { data: video, error: dbError } = await supabase
            .from('videos')
            .insert(videoData)
            .select()
            .single();

          if (dbError) {
            console.error('❌ Database insert failed:', dbError);
            // Clean up storage files
            await supabase.storage.from('videos').remove([videoName]);
            if (coverName) await supabase.storage.from('covers').remove([coverName]);
            
            return resolve(res.status(500).json({ 
              success: false, 
              error: 'Failed to save video metadata',
              details: dbError.message
            }));
          }
          console.log('✅ Video metadata saved');

          // 4. Update user's video count
          console.log('🔄 Updating user video count...');
          await supabase
            .from('users')
            .update({ 
              video_count: (user.video_count || 0) + 1,
              last_upload: new Date().toISOString()
            })
            .eq('id', userId);

          console.log('🎉 Video upload completed successfully!');

          return resolve(res.status(200).json({
            success: true,
            message: 'Video uploaded successfully',
            video: {
              id: videoId,
              title: videoTitle,
              video_url: videoPublicUrl,
              cover_url: coverPublicUrl,
              description: description,
              tags: tagsArray,
              views: 0,
              created_at: video.created_at,
              user_id: userId,
              username: user.username
            }
          }));

        } catch (err) {
          console.error('💥 Upload processing error:', err);
          return resolve(res.status(500).json({ 
            success: false, 
            error: 'Upload processing failed',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
          }));
        }
      });

      bb.on('error', (err) => {
        console.error('Busboy error:', err);
        resolve(res.status(500).json({ 
          success: false, 
          error: 'Form parsing failed' 
        }));
      });

      req.pipe(bb);
    });

  } catch (err) {
    console.error('💥 Upload handler error:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
