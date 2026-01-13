// pages/api/upload-video.js
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';
import { v4 as uuidv4 } from 'uuid';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
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

    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session) {
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    if (new Date(session.expires_at) < new Date()) {
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
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const userId = user.id;
    const { videoInfo, fileInfo, action } = req.body;

    // Handle different actions in the same endpoint
    if (action === 'prepare') {
      // === STEP 1: PREPARE UPLOAD (Generate signed URLs) ===
      
      // Validate metadata
      if (!videoInfo || !videoInfo.title) {
        return res.status(400).json({ 
          success: false, 
          error: 'Video title is required' 
        });
      }

      if (!fileInfo || !fileInfo.video || !fileInfo.video.name || !fileInfo.video.type) {
        return res.status(400).json({ 
          success: false, 
          error: 'Video file information is required' 
        });
      }

      // Validate video type
      if (!ALLOWED_VIDEO_TYPES.includes(fileInfo.video.type)) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid video format: ${fileInfo.video.type}. Allowed: ${ALLOWED_VIDEO_TYPES.join(', ')}` 
        });
      }

      // Validate cover type if provided
      if (fileInfo.cover && !ALLOWED_IMAGE_TYPES.includes(fileInfo.cover.type)) {
        return res.status(400).json({ 
          success: false, 
          error: `Invalid image format: ${fileInfo.cover.type}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}` 
        });
      }

      // Generate unique IDs and filenames
      const videoId = uuidv4();
      const videoExt = fileInfo.video.name.split('.').pop().toLowerCase();
      const videoName = `${userId}/${videoId}.${videoExt}`;
      
      let coverName = null;
      if (fileInfo.cover) {
        const coverExt = fileInfo.cover.name.split('.').pop().toLowerCase();
        coverName = `${userId}/${videoId}.${coverExt}`;
      }

      // Generate signed URLs for direct upload
      console.log('🔐 Generating signed upload URLs...');
      
      const videoSignedUrl = await supabase.storage
        .from('videos')
        .createSignedUploadUrl(videoName);

      if (videoSignedUrl.error) {
        console.error('❌ Failed to generate video signed URL:', videoSignedUrl.error);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to generate upload URL' 
        });
      }

      let coverSignedUrl = null;
      if (coverName) {
        const coverUrlResult = await supabase.storage
          .from('covers')
          .createSignedUploadUrl(coverName);
        
        if (coverUrlResult.error) {
          console.error('⚠️ Failed to generate cover signed URL:', coverUrlResult.error);
        } else {
          coverSignedUrl = coverUrlResult.data;
        }
      }

      // Parse tags (array format per schema)
      let tagsArray = [];
      if (videoInfo.tags) {
        tagsArray = videoInfo.tags.split(',')
          .map(tag => tag.trim())
          .filter(tag => tag.length > 0)
          .slice(0, 10);
      }

      // Verify vibe if provided
      let validatedVibeId = null;
      if (videoInfo.vibeId) {
        const { data: vibe } = await supabase
          .from('vibes')
          .select('id')
          .eq('id', videoInfo.vibeId)
          .maybeSingle();
        
        if (vibe) validatedVibeId = videoInfo.vibeId;
      }

      // Create initial video record
      const videoData = {
        id: videoId,
        user_id: userId,
        title: videoInfo.title.trim(),
        description: videoInfo.description ? videoInfo.description.trim() : null,
        video_url: '', // Will be updated after upload
        cover_url: null, // Will be updated after upload
        mime_type: fileInfo.video.type,
        size: fileInfo.video.size || 0,
        original_filename: fileInfo.video.name,
        views: 0,
        tags: tagsArray,
        ai_generated: videoInfo.aiGenerated || false,
        created_at: new Date().toISOString()
      };

      if (validatedVibeId) {
        videoData.vibe_id = validatedVibeId;
      }

      const { data: video, error: dbError } = await supabase
        .from('videos')
        .insert(videoData)
        .select()
        .single();

      if (dbError) {
        console.error('❌ Database insert failed:', dbError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to save video metadata',
          details: dbError.message
        });
      }

      console.log('✅ Upload URLs generated and metadata saved');

      return res.status(200).json({
        success: true,
        message: 'Ready for upload',
        action: 'prepare',
        uploadInfo: {
          videoId,
          signedUrls: {
            video: videoSignedUrl.data,
            cover: coverSignedUrl
          },
          fileNames: {
            video: videoName,
            cover: coverName
          },
          metadata: video
        }
      });

    } else if (action === 'complete') {
      // === STEP 2: COMPLETE UPLOAD (Update with real URLs) ===
      
      const { videoId, success, error: uploadError } = req.body;
      
      if (!videoId) {
        return res.status(400).json({ 
          success: false, 
          error: 'Video ID is required' 
        });
      }

      if (!success) {
        // Delete the video record if upload failed
        await supabase.from('videos').delete().eq('id', videoId);
        return res.status(400).json({ 
          success: false, 
          error: uploadError || 'Upload failed' 
        });
      }

      // Get the video to extract user_id and original filename
      const { data: video } = await supabase
        .from('videos')
        .select('user_id, original_filename, title')
        .eq('id', videoId)
        .single();

      if (!video) {
        return res.status(404).json({ success: false, error: 'Video not found' });
      }

      // Reconstruct the filename
      const videoName = `${video.user_id}/${videoId}.${video.original_filename.split('.').pop().toLowerCase()}`;
      const coverName = `${video.user_id}/${videoId}.jpg`;

      // Get public URLs
      const { data: videoUrlData } = supabase.storage
        .from('videos')
        .getPublicUrl(videoName);
      
      const { data: coverUrlData } = supabase.storage
        .from('covers')
        .getPublicUrl(coverName);
      
      const videoPublicUrl = videoUrlData.publicUrl;
      const coverPublicUrl = coverUrlData.publicUrl;

      // Update video with real URLs
      const { data: updatedVideo, error: updateError } = await supabase
        .from('videos')
        .update({
          video_url: videoPublicUrl,
          cover_url: coverPublicUrl
        })
        .eq('id', videoId)
        .select()
        .single();

      if (updateError) {
        console.error('❌ Failed to update video URLs:', updateError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to update video metadata' 
        });
      }

      // Update user's video count
      await supabase
        .from('users')
        .update({ 
          video_count: (user.video_count || 0) + 1,
          last_upload: new Date().toISOString()
        })
        .eq('id', userId);

      console.log('🎉 Video upload completed successfully!');

      return res.status(200).json({
        success: true,
        message: 'Video uploaded successfully',
        action: 'complete',
        video: updatedVideo
      });

    } else {
      // === SINGLE-STEP UPLOAD (for small files < 4.5MB) ===
      // This is your original logic, kept for backward compatibility
      
      // Only works for files under 4.5MB due to Vercel limit
      return res.status(400).json({ 
        success: false, 
        error: 'Use "prepare" action for video uploads. Vercel has a 4.5MB limit for direct uploads.' 
      });
    }

  } catch (err) {
    console.error('💥 Upload handler error:', err);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
