// pages/api/view-videos.js (UPDATED FIX)
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    console.log('👀 View-videos API called, method:', req.method);
    
    let userId = null;
    let userEmail = null;
    
    // Check if user is authenticated
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;
    
    if (sessionToken) {
      const { data: session } = await supabase
        .from('sessions')
        .select('user_id, user_email, expires_at')
        .eq('session_token', sessionToken)
        .maybeSingle();

      if (session && new Date(session.expires_at) > new Date()) {
        userId = session.user_id;
        userEmail = session.user_email;
        console.log('✅ User authenticated, ID:', userId);
      }
    }

    // Handle POST: add a new comment
    if (req.method === 'POST') {
      console.log('💬 POST request - adding comment');
      
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { videoId } = req.query;
      const { text } = req.body;

      console.log('💬 Comment details - Video ID:', videoId);

      if (!text) return res.status(400).json({ error: 'Comment text required' });
      if (!videoId) return res.status(400).json({ error: 'Video ID required' });

      // Verify video exists
      const { data: video } = await supabase
        .from('videos')
        .select('id, user_id, views')
        .eq('id', videoId)
        .maybeSingle();

      if (!video) return res.status(404).json({ error: 'Video not found' });

      // Get user info for response
      const { data: user } = await supabase
        .from('users')
        .select('id, username, avatar_url, email')
        .eq('id', userId)
        .single();

      // Insert comment
      const { data: newComment, error } = await supabase
        .from('comments')
        .insert({
          user_id: userId,
          video_id: videoId,
          comment_text: text
        })
        .select('*')
        .single();

      if (error) {
        console.error('❌ Comment insert error:', error);
        return res.status(500).json({ error: error.message });
      }

      console.log('✅ Comment posted successfully');
      
      return res.status(200).json({
        id: newComment.id,
        text: newComment.comment_text,
        created_at: newComment.created_at,
        user: user
      });
    }

    // Handle GET: list videos with likes and views
    if (req.method === 'GET') {
      console.log('📹 GET request - fetching videos');
      
      const { statsOnly, ids, since, videoId: singleVideoId, incrementViews } = req.query;
      
      // ========== STATS ONLY MODE (for polling/real-time updates) ==========
      if (statsOnly === 'true' && ids) {
        console.log(`📊 STATS ONLY MODE - Getting stats for videos`);
        
        const videoIds = ids.split(',');
        
        const { data: videos, error: videosError } = await supabase
          .from('videos')
          .select(`
            id,
            views,
            likes_count,
            created_at
          `)
          .in('id', videoIds);
        
        if (videosError) {
          console.error('❌ Stats fetch error:', videosError);
          return res.status(500).json({ error: videosError.message });
        }
        
        if (!videos || videos.length === 0) {
          console.log('📊 No videos found');
          return res.status(200).json([]);
        }
        
        console.log(`📊 Found ${videos.length} videos`);
        
        // Get additional stats for each video
        const result = await Promise.all(
          videos.map(async (video) => {
            try {
              // Get like count from likes table
              const { count: likes } = await supabase
                .from('likes')
                .select('*', { count: 'exact', head: true })
                .eq('target_id', video.id)
                .eq('target_type', 'video');
              
              // Check if current user liked this video
              let hasLiked = false;
              if (userEmail) {
                const { data: userLike } = await supabase
                  .from('likes')
                  .select('id')
                  .eq('target_id', video.id)
                  .eq('target_type', 'video')
                  .eq('user_email', userEmail)
                  .maybeSingle();
                hasLiked = !!userLike;
              }
              
              // Get comment count
              const { count: commentCount } = await supabase
                .from('comments')
                .select('*', { count: 'exact', head: true })
                .eq('video_id', video.id);
              
              // Get new comments since last check
              const { data: newComments } = await supabase
                .from('comments')
                .select(`
                  id, 
                  user_id, 
                  video_id, 
                  comment_text, 
                  created_at,
                  users (id, username, email, avatar_url, profile_picture)
                `)
                .eq('video_id', video.id)
                .order('created_at', { ascending: true })
                .limit(10);
              
              // Process new comments to include user data
              const processedNewComments = (newComments || []).map(comment => ({
                id: comment.id,
                text: comment.comment_text,
                created_at: comment.created_at,
                user: {
                  ...comment.users,
                  avatar_url: comment.users?.avatar_url || comment.users?.profile_picture
                }
              }));
              
              return {
                id: video.id,
                views: video.views || 0,
                likes: video.likes_count || likes || 0,
                hasLiked,
                commentCount: commentCount || 0,
                newComments: processedNewComments,
                updated_at: video.created_at
              };
            } catch (err) {
              console.error(`❌ Error processing video ${video.id}:`, err.message);
              return {
                id: video.id,
                views: video.views || 0,
                likes: video.likes_count || 0,
                hasLiked: false,
                commentCount: 0,
                newComments: [],
                updated_at: video.created_at
              };
            }
          })
        );
        
        console.log(`📊 Returning stats for ${result.length} videos`);
        return res.status(200).json(result);
      }
      
      // ========== SINGLE VIDEO REQUEST ==========
      if (singleVideoId) {
        console.log(`🎬 Single video requested: ${singleVideoId}`);
        
        const { data: videos, error: videosError } = await supabase
          .from('videos')
          .select(`
            id,
            user_id,
            title,
            description,
            video_url,
            url,
            cover_url,
            original_filename,
            mime_type,
            size,
            views,
            likes_count,
            created_at,
            users ( id, email, username, avatar_url, profile_picture, online )
          `)
          .eq('id', singleVideoId)
          .limit(1);

        if (videosError || !videos || videos.length === 0) {
          console.error('❌ Video not found');
          return res.status(404).json({ error: 'Video not found' });
        }

        const video = videos[0];
        
        // Process the single video
        const result = await processVideoData(video, userEmail, userId);
        
        // INCREMENT VIEW COUNT if requested
        if (incrementViews === 'true') {
          console.log(`📹 Incrementing view count for video ${video.id}`);
          const { data: updatedVideo } = await supabase
            .from('videos')
            .update({ 
              views: (video.views || 0) + 1
            })
            .eq('id', video.id)
            .select('views')
            .single();
          
          if (updatedVideo) {
            result.views = updatedVideo.views;
          }
        }
        
        return res.status(200).json(result);
      }
      
      // ========== ALL VIDEOS REQUEST ==========
      console.log('📹 Getting all videos');
      
      // Get all videos from database
      const { data: videos, error: videosError } = await supabase
        .from('videos')
        .select(`
          id,
          user_id,
          title,
          description,
          video_url,
          url,
          cover_url,
          original_filename,
          mime_type,
          size,
          views,
          likes_count,
          created_at,
          users ( id, email, username, avatar_url, profile_picture, online )
        `)
        .order('created_at', { ascending: false })
        .limit(100);

      if (videosError) {
        console.error('❌ Videos fetch error:', videosError);
        return res.status(500).json({ error: videosError.message });
      }
      
      if (!videos || videos.length === 0) {
        console.log('📭 No videos found');
        return res.status(200).json([]);
      }

      console.log(`📹 Found ${videos.length} videos`);
      
      // Build response with additional data
      const result = await Promise.all(
        videos.map(async (video) => {
          return await processVideoData(video, userEmail, userId);
        })
      );

      console.log('✅ Returning', result.length, 'videos');
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('❌❌❌ Video API crash:', err);
    console.error('❌❌❌ Error stack:', err.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: err.message
    });
  }
}

// Helper function to process video data
async function processVideoData(video, userEmail, userId) {
  try {
    console.log(`📹 Processing video: ${video.id} - ${video.title || 'Untitled'}`);
    
    // Get like count from likes table
    const { count: likes } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('target_id', video.id)
      .eq('target_type', 'video');

    // Check if current user liked this video
    let hasLiked = false;
    if (userEmail) {
      const { data: userLike } = await supabase
        .from('likes')
        .select('id')
        .eq('target_id', video.id)
        .eq('target_type', 'video')
        .eq('user_email', userEmail)
        .maybeSingle();
      hasLiked = !!userLike;
    }

    // Handle URLs - use video_url or url
    let videoUrl = video.video_url || video.url;
    let coverUrl = video.cover_url;

    // Generate proper storage URLs
    if (videoUrl && !videoUrl.startsWith('http') && !videoUrl.startsWith('blob:')) {
      try {
        console.log(`🔄 Generating video URL for: ${videoUrl}`);
        const { data: publicUrlData } = supabase.storage
          .from('videos')
          .getPublicUrl(videoUrl);
        videoUrl = publicUrlData.publicUrl;
        console.log(`✅ Video URL: ${videoUrl.substring(0, 100)}...`);
      } catch (error) {
        console.error('❌ Error creating video URL:', error);
      }
    }
    
    if (coverUrl && !coverUrl.startsWith('http') && !coverUrl.startsWith('blob:')) {
      try {
        console.log(`🔄 Generating cover URL for: ${coverUrl}`);
        const { data: publicUrlData } = supabase.storage
          .from('covers')
          .getPublicUrl(coverUrl);
        coverUrl = publicUrlData.publicUrl;
        console.log(`✅ Cover URL: ${coverUrl}`);
      } catch (error) {
        console.error('❌ Error creating cover URL:', error);
      }
    }

    // Get comments with user info
    const { data: comments } = await supabase
      .from('comments')
      .select(`
        id, 
        user_id, 
        video_id, 
        comment_text, 
        created_at, 
        edited_at,
        users (id, username, email, avatar_url, profile_picture)
      `)
      .eq('video_id', video.id)
      .order('created_at', { ascending: true });

    // Process comments to include user data
    const processedComments = (comments || []).map(comment => ({
      id: comment.id,
      text: comment.comment_text,
      created_at: comment.created_at,
      edited_at: comment.edited_at,
      user: {
        ...comment.users,
        avatar_url: comment.users?.avatar_url || comment.users?.profile_picture
      }
    }));

    // Handle user avatar
    let userData = video.users;
    if (userData) {
      userData = {
        ...userData,
        avatar_url: userData.avatar_url || userData.profile_picture
      };
    }

    return {
      id: video.id,
      title: video.title,
      description: video.description,
      likes: video.likes_count || likes || 0,
      hasLiked,
      views: video.views || 0,
      uploaded_at: video.created_at,
      videoUrl,
      coverUrl,
      user: userData,
      comments: processedComments
    };
  } catch (err) {
    console.error(`❌ Error in processVideoData for video ${video.id}:`, err.message);
    return {
      id: video.id,
      title: video.title,
      description: video.description,
      likes: video.likes_count || 0,
      hasLiked: false,
      views: video.views || 0,
      uploaded_at: video.created_at,
      videoUrl: video.video_url || video.url,
      coverUrl: video.cover_url,
      user: video.users,
      comments: []
    };
  }
}
