// pages/api/view-videos.js (UPDATED)
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    console.log('👀 View-videos API called, method:', req.method);
    
    let userId = null;
    
    // Check if user is authenticated
    const cookies = req.headers.cookie ? cookie.parse(req.headers.cookie) : {};
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;
    
    console.log('🔍 Session token present:', !!sessionToken);
    
    if (sessionToken) {
      const { data: session } = await supabase
        .from('sessions')
        .select('user_id, expires_at')
        .eq('session_token', sessionToken)
        .maybeSingle();

      if (session && new Date(session.expires_at) > new Date()) {
        userId = session.user_id;
        console.log('✅ User authenticated, ID:', userId);
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
        .select('id, user_id')
        .eq('id', videoId)
        .maybeSingle();

      if (!video) return res.status(404).json({ error: 'Video not found' });

      // Get user info for response
      const { data: user } = await supabase
        .from('users')
        .select('id, username, avatar_url')
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
      
      // Get videos from database (not storage)
      const { data: videos, error: videosError } = await supabase
        .from('videos')
        .select(`
          id,
          user_id,
          title,
          description,
          video_url,
          cover_url,
          original_filename,
          mime_type,
          size,
          views,
          created_at,
          users ( id, email, username, avatar_url, online )
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
        videos.map(async (video, index) => {
          console.log(`📹 Processing video ${index + 1}/${videos.length}: ${video.title}`);
          console.log(`📹 Video URL in DB: ${video.video_url}`);
          console.log(`📹 Cover URL in DB: ${video.cover_url}`);

          // Get like count and check if user liked
          const { count: likes } = await supabase
            .from('likes')
            .select('*', { count: 'exact', head: true })
            .eq('video_id', video.id);

          let hasLiked = false;
          if (userId) {
            const { data: userLike } = await supabase
              .from('likes')
              .select('id')
              .eq('user_id', userId)
              .eq('video_id', video.id)
              .maybeSingle();
            hasLiked = !!userLike;
          }

          console.log(`📹 Likes: ${likes || 0}, User liked: ${hasLiked}`);

          // Increment view count (only count once per session)
          if (req.headers['x-view-increment'] === 'true') {
            console.log(`📹 Incrementing view count for video ${video.id}`);
            await supabase
              .from('videos')
              .update({ views: (video.views || 0) + 1 })
              .eq('id', video.id);
          }

          // IMPORTANT: video.video_url is already a PUBLIC URL from upload-video.js
          // We don't need to create signed URLs for public access
          // Only use signed URLs if videos are in private buckets
          
          let videoUrl = video.video_url;
          let coverUrl = video.cover_url;
          
          // If URLs are relative paths (like "user-id/video-id.mp4"), create public URLs
          if (videoUrl && !videoUrl.startsWith('http')) {
            console.log(`📹 Creating public URL for relative video path: ${videoUrl}`);
            const { data: publicUrlData } = supabase.storage
              .from('videos')
              .getPublicUrl(videoUrl);
            videoUrl = publicUrlData.publicUrl;
          }
          
          if (coverUrl && !coverUrl.startsWith('http')) {
            console.log(`📹 Creating public URL for relative cover path: ${coverUrl}`);
            const { data: publicUrlData } = supabase.storage
              .from('covers')
              .getPublicUrl(coverUrl);
            coverUrl = publicUrlData.publicUrl;
          }

          console.log(`📹 Final video URL: ${videoUrl}`);
          console.log(`📹 Final cover URL: ${coverUrl}`);

          // Get comments
          const { data: comments } = await supabase
            .from('comments')
            .select(`
              id,
              user_id,
              video_id,
              comment_text,
              created_at,
              edited_at,
              users ( id, username, email, avatar_url )
            `)
            .eq('video_id', video.id)
            .order('created_at', { ascending: true });

          console.log(`📹 Comments: ${comments?.length || 0}`);

          return {
            id: video.id,
            title: video.title,
            description: video.description,
            likes: likes || 0,
            hasLiked,
            views: video.views || 0,
            uploaded_at: video.created_at,
            videoUrl,  // Already public URL
            coverUrl,  // Already public URL
            user: video.users,
            comments: (comments || []).map(c => ({
              id: c.id,
              user_id: c.user_id,
              video_id: c.video_id,
              text: c.comment_text,
              created_at: c.created_at,
              edited_at: c.edited_at,
              user: c.users
            }))
          };
        })
      );

      console.log('✅ Returning', result.length, 'videos');
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('❌❌❌ Video API crash:', err);
    console.error('❌❌❌ Error stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
}
