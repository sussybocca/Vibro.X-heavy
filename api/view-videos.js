import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-only
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  try {
    // List all files in the 'videos' storage bucket
    const { data: files, error: listError } = await supabase
      .storage
      .from('videos')
      .list('', { limit: 100, offset: 0 });

    if (listError) return res.status(500).json({ error: listError.message });
    if (!files || files.length === 0) return res.status(200).json([]);

    const videosWithUserAndComments = await Promise.all(
      files.map(async (file) => {
        // Get video metadata from videos table
        const { data: videoRecord, error: videoError } = await supabase
          .from('videos')
          .select('id, user_id, created_at, cover_url, title, description')
          .eq('video_url', file.name)
          .maybeSingle();

        if (videoError || !videoRecord) return null;

        // Count likes for this video from votes table
        const { data: votesData } = await supabase
          .from('votes')
          .select('id', { count: 'exact' })
          .eq('item_type', 'video')
          .eq('item_id', videoRecord.id);

        const likesCount = votesData ? votesData.length : 0;

        // Create signed URL for the video
        const { data: signedVideoData, error: signedVideoError } = await supabase
          .storage
          .from('videos')
          .createSignedUrl(file.name, 3600);

        if (signedVideoError) return null;

        // Create signed URL for cover art if exists
        let coverUrl = null;
        if (videoRecord.cover_url) {
          const { data: signedCoverData, error: signedCoverError } = await supabase
            .storage
            .from('covers')
            .createSignedUrl(videoRecord.cover_url, 3600);
          if (!signedCoverError) coverUrl = signedCoverData.signedUrl;
        }

        // Fetch user info from users table
        const { data: userData } = await supabase
          .from('users')
          .select('id, email')
          .eq('id', videoRecord.user_id)
          .maybeSingle();

        const user = userData ? { id: userData.id, email: userData.email } : null;

        // Fetch comments for this video with user email (optimized join)
        const { data: commentsData } = await supabase
          .from('comments')
          .select(`
            id,
            comment_text,
            created_at,
            likes_count,
            user:users(id, email)
          `)
          .eq('video_id', videoRecord.id)
          .order('created_at', { ascending: true });

        const commentsWithUsers = (commentsData || []).map((c) => ({
          id: c.id,
          user: c.user ? c.user.email : 'Unknown',
          text: c.comment_text,
          created_at: c.created_at,
          likes: c.likes_count || 0
        }));

        return {
          id: videoRecord.id,
          name: file.name,
          size: file.size,
          title: videoRecord.title,
          description: videoRecord.description,
          likes: likesCount,
          uploaded_at: videoRecord.created_at ? new Date(videoRecord.created_at).toISOString() : null,
          videoUrl: signedVideoData.signedUrl,
          coverUrl,
          user,
          comments: commentsWithUsers
        };
      })
    );

    const filteredVideos = videosWithUserAndComments.filter(v => v); // remove nulls

    res.status(200).json(filteredVideos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
