const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const PORT = 3001;

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'temp/');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}_${file.originalname}`);
  }
});

const upload = multer({ storage });

// Ensure temp directory exists
const ensureTempDir = async () => {
  try {
    await fs.access('temp');
  } catch {
    await fs.mkdir('temp', { recursive: true });
  }
};

// Utility function to download file from URL
const downloadFile = async (url, filepath) => {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream'
  });
  
  const writer = fsSync.createWriteStream(filepath);
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

// Global variables to store file paths
let currentVideoPath = null;
let processedVideoPath = null;
let finalVideoPath = null;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Video processing server is running' });
});

// Extract audio from video
app.post('/extract-audio', async (req, res) => {
  try {
    const { videoUrl } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'Video URL is required' });
    }

    await ensureTempDir();
    
    // Download video
    const videoId = uuidv4();
    const videoPath = path.join('temp', `${videoId}_input.mp4`);
    const audioPath = path.join('temp', `${videoId}_audio.wav`);
    
    console.log('Downloading video from:', videoUrl);
    await downloadFile(videoUrl, videoPath);
    
    // Store video path for later use
    currentVideoPath = videoPath;
    
    // Extract audio
    console.log('Extracting audio...');
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .output(audioPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Upload audio to a temporary hosting service or return local path
    // For now, we'll assume you have a way to host the audio file
    const audioUrl = `http://localhost:${PORT}/temp-audio/${path.basename(audioPath)}`;
    
    res.json({
      success: true,
      audioUrl: audioUrl,
      audioPath: audioPath,
      videoPath: videoPath
    });
    
  } catch (error) {
    console.error('Error extracting audio:', error);
    res.status(500).json({ error: 'Failed to extract audio', details: error.message });
  }
});

// Serve temporary audio files
app.get('/temp-audio/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join('temp', filename);
  
  if (fsSync.existsSync(filePath)) {
    res.sendFile(path.resolve(filePath));
  } else {
    res.status(404).json({ error: 'Audio file not found' });
  }
});

// Process video to remove segments
app.post('/process-video', async (req, res) => {
  try {
    const { videoPath, filterComplex } = req.body;
    
    if (!currentVideoPath) {
      return res.status(400).json({ error: 'No video file available for processing' });
    }
    
    const outputPath = path.join('temp', `processed_${uuidv4()}.mp4`);
    processedVideoPath = outputPath;
    
    console.log('Processing video with complex filter...');
    console.log('Filter complex:', filterComplex);
    console.log('CurrentVideoPath:', currentVideoPath);
    console.log('ProcessedVideoPath:', processedVideoPath);
    
    // If no segments to remove, just copy the file
    if (!filterComplex) {
      await fs.copyFile(currentVideoPath, outputPath);
      //just added for testing
      finalVideoPath = outputPath;
      res.json({
        success: true,
        message: 'No segments to remove, video copied as-is',
        outputPath: outputPath
      });
      return;
    }
    
    
    // Apply complex filter to process both audio and video together
    await new Promise((resolve, reject) => {
      const command = ffmpeg(currentVideoPath);
      
      command
        .complexFilter(filterComplex)
        .outputOptions([
          '-map', '[outv]',
          '-map', '[outa]'
        ])
        .output(outputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-preset veryfast',
          '-crf 23',
          '-threads 1',
          '-avoid_negative_ts make_zero'  // Helps with timing issues
        ])
        .on('progress', (progress) => {
          console.log('Processing progress:', progress.percent + '%');
        })
        .on('end', () => {
          console.log('Video processing completed');
          finalVideoPath = outputPath;
          resolve();
        })
        .on('error', (error) => {
          console.error('FFmpeg error:', error);
          reject(error);
        })
        .run();
    });
    
    res.json({
      success: true,
      message: 'Video processed successfully',
      outputPath: outputPath,
      stats: {
        originalSize: (await fs.stat(currentVideoPath)).size,
        processedSize: (await fs.stat(outputPath)).size
      }
    });
    
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Failed to process video', details: error.message });
  }
});

// Add background music and subtitles
app.post('/add-music-subtitles', async (req, res) => {
  try {
    const { videoPath, musicPath, subtitleContent, srtSubtitles } = req.body;
    
    if (!processedVideoPath) {
      return res.status(400).json({ error: 'No processed video available' });
    }
    
    // Verify input video exists
    if (!fsSync.existsSync(processedVideoPath)) {
      return res.status(400).json({ error: 'Input video file does not exist' });
    }
    
    const outputPath = path.join('temp', `final_${uuidv4()}.mp4`);
    const subtitlePath = path.join('temp', `subtitles_${uuidv4()}.srt`);
    
    finalVideoPath = outputPath;
    
    // Use srtSubtitles if available, otherwise fall back to subtitleContent
    const subtitleText = srtSubtitles || subtitleContent;
    
    if (!subtitleText) {
      return res.status(400).json({ error: 'No subtitle content provided' });
    }
    
    // Write subtitle content to file
    await fs.writeFile(subtitlePath, subtitleText, 'utf8');
    
    console.log('Adding subtitles...');
    console.log('Input video:', processedVideoPath);
    console.log('Output path:', outputPath);
    console.log('Subtitle path:', subtitlePath);
    
    await new Promise((resolve, reject) => {
      const command = ffmpeg(processedVideoPath);
      
      // Add subtitles with proper escaping and better styling
      const escapedSubtitlePath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      
      command.outputOptions([
        '-vf', `subtitles='${escapedSubtitlePath}':force_style='FontName=Arial,FontSize=10,PrimaryColour=&Hffffff&,BackColour=&H80000000&,Bold=1,Outline=2,OutlineColour=&H000000&,MarginV=30,MarginL=60,MarginR=60,Alignment=2'`
      ]);
      
      command
        .output(outputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
          '-preset veryfast',
          '-crf 23',
          '-threads 1',
          '-avoid_negative_ts make_zero',
          '-movflags', '+faststart',
          '-y' // Overwrite output file if exists
        ])
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log('Final processing progress:', Math.round(progress.percent) + '%');
          }
        })
        .on('stderr', (stderrLine) => {
          console.log('FFmpeg stderr:', stderrLine);
        })
        .on('end', () => {
          console.log('Final video processing completed');
          // Clean up temporary subtitle file
          fsSync.unlink(subtitlePath, (err) => {
            if (err) console.warn('Failed to delete temp subtitle file:', err);
          });
          resolve();
        })
        .on('error', (error) => {
          console.error('FFmpeg error in final processing:', error);
          console.error('FFmpeg stderr:', error.stderr);
          // Clean up on error
          fsSync.unlink(subtitlePath, () => {});
          reject(error);
        })
        .run();
    });
    
    // Verify output file was created
    if (!fsSync.existsSync(outputPath)) {
      throw new Error('Output video file was not created');
    }
    
    const stats = await fs.stat(outputPath);
    
    res.json({
      success: true,
      message: 'Subtitles added successfully',
      outputPath: outputPath,
      finalStats: {
        fileSize: stats.size,
        hasMusic: false, // No music for now
        hasSubtitles: true
      }
    });
    
  } catch (error) {
    console.error('Error adding subtitles:', error);
    res.status(500).json({ 
      error: 'Failed to add subtitles', 
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get final video file
app.get('/get-final-video', (req, res) => {
  if (!finalVideoPath || !fsSync.existsSync(finalVideoPath)) {
    return res.status(404).json({ error: 'Final video not found' });
  }
  
  res.sendFile(path.resolve(finalVideoPath));
});

// Cleanup temporary files
app.post('/cleanup', async (req, res) => {
  try {
    const filesToClean = [currentVideoPath, processedVideoPath, finalVideoPath];
    
    for (const filePath of filesToClean) {
      if (filePath && fsSync.existsSync(filePath)) {
        await fs.unlink(filePath);
        console.log('Deleted:', filePath);
      }
    }
    
    // Clean up temp directory of old files (older than 1 hour)
    const tempDir = 'temp';
    const files = await fs.readdir(tempDir);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtime.getTime() > oneHour) {
        await fs.unlink(filePath);
        console.log('Cleaned up old file:', filePath);
      }
    }
    
    // Reset global variables
    currentVideoPath = null;
    processedVideoPath = null;
    finalVideoPath = null;
    
    res.json({
      success: true,
      message: 'Cleanup completed successfully'
    });
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({ error: 'Cleanup failed', details: error.message });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ error: 'Internal server error', details: error.message });
});

// Start server
app.listen(PORT, async () => {
  await ensureTempDir();
  console.log(`Video processing server is running on http://localhost:${PORT}`);
  console.log('Available endpoints:');
  console.log('  POST /extract-audio - Extract audio from video');
  console.log('  POST /process-video - Apply filters to remove segments');
  console.log('  POST /add-music-subtitles - Add background music and subtitles');
  console.log('  GET /get-final-video - Download final processed video');
  console.log('  POST /cleanup - Remove temporary files');
  console.log('  GET /health - Health check');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down server...');
  // Clean up any remaining files
  try {
    await fs.rmdir('temp', { recursive: true });
    console.log('Temporary files cleaned up');
  } catch (error) {
    console.error('Error cleaning up:', error);
  }
  process.exit(0);
});
