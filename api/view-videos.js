// pages/api/view-videos.js (UPDATED TO MATCH YOUR SCHEMA)
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

// Initialize Supabase client - make sure this is at the module level
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    console.log('👀 View-videos API called, method:', req.method);
    console.log('📊 Query params:', req.query);
    
    let userId = null;
    let userEmail = null;
    
    // Check if user is authenticated
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;
    
    console.log('🔍 Session token present:', !!sessionToken);
    
    if (sessionToken) {
      const { data: session } = await supabase
        .from('sessions')
        .select('user_id, user_email, expires_at')
        .eq('session_token', sessionToken)
        .maybeSingle();

      if (session && new Date(session.expires_at) > new Date()) {
        userId = session.user_id;
        userEmail = session.user_email;
        console.log('✅ User authenticated, ID:', userId, 'Email:', userEmail);
      } else {
        console.log('❌ Session expired or invalid');
      }
    } else {
      console.log('❌ No session token - user is guest');
    }

    // Handle POST: add a new comment
    if (req.method === 'POST') {
      console.log('💬 POST request - adding comment');
      
      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { videoId } = req.query;
      const { text } = req.body;

      console.log('💬 Comment details - Video ID:', videoId, 'Text length:', text?.length);

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

      // ALSO UPDATE VIDEO TIMESTAMP for real-time detection
      await supabase
        .from('videos')
        .update({
          updated_at: new Date().toISOString()
        })
        .eq('id', videoId);

      // Send notification to video owner if not commenting on own video
      if (video.user_id !== userId) {
        await supabase
          .from('notifications')
          .insert({
            user_id: video.user_id,
            from_user_id: userId,
            type: 'video_comment',
            video_id: videoId,
            message: 'commented on your video',
            read: false,
            created_at: new Date().toISOString()
          });
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
        
        // Handle the since parameter
        let sinceTime;
        if (since) {
          const parsedSince = parseInt(since);
          if (!isNaN(parsedSince) && parsedSince > 0) {
            sinceTime = new Date(parsedSince).toISOString();
          } else {
            sinceTime = new Date(Date.now() - 30000).toISOString(); // Default: last 30 seconds
          }
        } else {
          sinceTime = new Date(Date.now() - 30000).toISOString(); // Default: last 30 seconds
        }
        
        console.log(`📊 Since time: ${sinceTime}`);
        
        // Get videos updated since the given time
        const { data: videos, error: videosError } = await supabase
          .from('videos')
          .select(`
            id,
            views,
            likes_count,
            updated_at
          `)
          .in('id', videoIds)
          .gte('updated_at', sinceTime)
          .order('updated_at', { ascending: false });
        
        if (videosError) {
          console.error('❌ Stats fetch error:', videosError);
          return res.status(500).json({ error: videosError.message });
        }
        
        if (!videos || videos.length === 0) {
          console.log('📊 No video updates since last check');
          return res.status(200).json([]);
        }
        
        console.log(`📊 Found ${videos.length} updated videos`);
        
        // Get additional stats for each updated video - UPDATED FOR YOUR SCHEMA
        const result = await Promise.all(
          videos.map(async (video) => {
            try {
              // Get like count (double-check from likes table) - USING user_email NOT user_id
              const { count: likes, error: likesError } = await supabase
                .from('likes')
                .select('*', { count: 'exact', head: true })
                .eq('target_id', video.id)
                .eq('target_type', 'video');
              
              if (likesError) {
                console.error(`❌ Likes count error for video ${video.id}:`, likesError);
              }
              
              // Check if current user liked this video - USING user_email
              let hasLiked = false;
              if (userEmail) {
                const { data: userLike, error: userLikeError } = await supabase
                  .from('likes')
                  .select('id')
                  .eq('target_id', video.id)
                  .eq('target_type', 'video')
                  .eq('user_email', userEmail)  // CHANGED FROM user_id TO user_email
                  .maybeSingle();
                
                if (!userLikeError) {
                  hasLiked = !!userLike;
                }
              }
              
              // Get comment count
              const { count: commentCount, error: commentCountError } = await supabase
                .from('comments')
                .select('*', { count: 'exact', head: true })
                .eq('video_id', video.id);
              
              if (commentCountError) {
                console.error(`❌ Comment count error for video ${video.id}:`, commentCountError);
              }
              
              // Get new comments since last check - SIMPLIFIED WITHOUT JOIN
              const { data: newComments, error: newCommentsError } = await supabase
                .from('comments')
                .select(`
                  id,
                  user_id,
                  video_id,
                  comment_text,
                  created_at
                `)
                .eq('video_id', video.id)
                .gte('created_at', sinceTime)
                .order('created_at', { ascending: true });
              
              if (newCommentsError) {
                console.error(`❌ New comments error for video ${video.id}:`, newCommentsError);
              }
              
              // Get user info for comments separately
              let commentsWithUsers = [];
              if (newComments && newComments.length > 0) {
                const userIds = [...new Set(newComments.map(c => c.user_id).filter(id => id))];
                if (userIds.length > 0) {
                  const { data: commentUsers } = await supabase
                    .from('users')
                    .select('id, username, avatar_url')
                    .in('id', userIds);
                  
                  const userMap = {};
                  if (commentUsers) {
                    commentUsers.forEach(user => {
                      userMap[user.id] = user;
                    });
                  }
                  
                  commentsWithUsers = newComments.map(c => ({
                    ...c,
                    users: userMap[c.user_id] || null
                  }));
                }
              }
              
              return {
                id: video.id,
                views: video.views || 0,
                likes: video.likes_count || likes || 0,
                hasLiked,
                commentCount: commentCount || 0,
                newComments: commentsWithUsers,
                updated_at: video.updated_at
              };
            } catch (err) {
              console.error(`❌ Error processing video ${video.id}:`, err);
              console.error(`❌ Error details:`, err.message);
              console.error(`❌ Error stack:`, err.stack);
              
              // Return basic stats even if there's an error
              return {
                id: video.id,
                views: video.views || 0,
                likes: video.likes_count || 0,
                hasLiked: false,
                commentCount: 0,
                newComments: [],
                updated_at: video.updated_at
              };
            }
          })
        );
        
        console.log(`📊 Returning stats for ${result.length} updated videos`);
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
            url,  // ADDED: Your schema has both video_url and url
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
          console.error('❌ Video not found:', videosError);
          return res.status(404).json({ error: 'Video not found' });
        }

        const video = videos[0];
        
        // Process the single video
        const result = await processVideoData(video, userEmail, userId);
        
        // INCREMENT VIEW COUNT if requested (when someone actually watches)
        if (incrementViews === 'true') {
          console.log(`📹 Incrementing view count for video ${video.id}`);
          const { data: updatedVideo } = await supabase
            .from('videos')
            .update({ 
              views: (video.views || 0) + 1,
              updated_at: new Date().toISOString()
            })
            .eq('id', video.id)
            .select('views')
            .single();
          
          // Update the views in response
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
          url,  // ADDED
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
    console.error('❌❌❌ Request query:', req.query);
    console.error('❌❌❌ Request method:', req.method);
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
}

// Helper function to process video data - UPDATED FOR YOUR SCHEMA
async function processVideoData(video, userEmail, userId) {
  try {
    console.log(`📹 Processing video: ${video.title || 'Untitled'}`);
    
    // Get like count from likes table - USING user_email NOT user_id
    const { count: likes, error: likesError } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('target_id', video.id)
      .eq('target_type', 'video');

    if (likesError) {
      console.error('❌ Likes count error:', likesError);
    }

    // Check if current user has liked this video - USING user_email
    let hasLiked = false;
    if (userEmail) {
      const { data: userLike, error: userLikeError } = await supabase
        .from('likes')
        .select('id')
        .eq('target_id', video.id)
        .eq('target_type', 'video')
        .eq('user_email', userEmail)  // CHANGED FROM user_id TO user_email
        .maybeSingle();

      if (!userLikeError) {
        hasLiked = !!userLike;
      }
    }

    console.log(`📹 Likes: ${likes || 0}, User liked: ${hasLiked}, Views: ${video.views || 0}`);

    // Handle URLs - CHECK BOTH video_url AND url COLUMNS
    let videoUrl = video.video_url || video.url;  // Get from either column
    
    // If URLs are relative paths, create public URLs
    if (videoUrl && !videoUrl.startsWith('http')) {
      console.log(`📹 Creating public URL for relative video path: ${videoUrl}`);
      try {
        const { data: publicUrlData } = supabase.storage
          .from('videos')
          .getPublicUrl(videoUrl);
        videoUrl = publicUrlData.publicUrl;
      } catch (error) {
        console.error('❌ Error creating video URL:', error);
      }
    }
    
    let coverUrl = video.cover_url;
    if (coverUrl && !coverUrl.startsWith('http')) {
      console.log(`📹 Creating public URL for relative cover path: ${coverUrl}`);
      try {
        const { data: publicUrlData } = supabase.storage
          .from('covers')
          .getPublicUrl(coverUrl);
        coverUrl = publicUrlData.publicUrl;
      } catch (error) {
        console.error('❌ Error creating cover URL:', error);
      }
    }

    // Get comments - SEPARATE QUERIES TO AVOID JOIN ISSUES
    const { data: comments, error: commentsError } = await supabase
      .from('comments')
      .select(`
        id,
        user_id,
        video_id,
        comment_text,
        created_at,
        edited_at
      `)
      .eq('video_id', video.id)
      .order('created_at', { ascending: true });

    if (commentsError) {
      console.error('❌ Comments fetch error:', commentsError);
    }

    // Get user info for comments
    let commentsWithUsers = [];
    if (comments && comments.length > 0) {
      const userIds = [...new Set(comments.map(c => c.user_id).filter(id => id))];
      if (userIds.length > 0) {
        const { data: commentUsers } = await supabase
          .from('users')
          .select('id, username, email, avatar_url, profile_picture')
          .in('id', userIds);
        
        const userMap = {};
        if (commentUsers) {
          commentUsers.forEach(user => {
            userMap[user.id] = user;
          });
        }
        
        commentsWithUsers = comments.map(c => ({
          id: c.id,
          user_id: c.user_id,
          video_id: c.video_id,
          text: c.comment_text,
          created_at: c.created_at,
          edited_at: c.edited_at,
          user: userMap[c.user_id] || null
        }));
      }
    }

    // Handle user avatar - check both avatar_url and profile_picture
    let userData = video.users;
    if (userData) {
      // Ensure avatar_url is populated
      if (!userData.avatar_url && userData.profile_picture) {
        userData = { ...userData, avatar_url: userData.profile_picture };
      }
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
      comments: commentsWithUsers
    };
  } catch (err) {
    console.error(`❌ Error in processVideoData for video ${video.id}:`, err);
    console.error(`❌ Error details:`, err.message);
    console.error(`❌ Error stack:`, err.stack);
    
    // Return basic video data even if there's an error
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
