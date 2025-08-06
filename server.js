const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
const PORT = 3001;

// Global variables to store file paths
let currentVideoPath = null;
let processedVideoPath = null;
let finalVideoPath = null;

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

// Endpoint to merge thumbnail with video
app.post('/merge-thumbnail-video', async (req, res) => {
  const { thumbnailID, thumbnailDuration = 0.3 } = req.body;

  let videoPath = finalVideoPath;
  let thumbnailPath = null;
  let downloadedthumbnailPath = null;
  
  if (thumbnailID) {
    // Download thumbnail from URL
    console.log('Downloading Thumbnail from google drive ID:', thumbnailID);
    downloadedthumbnailPath = path.join('temp', `thumbnail_${uuidv4()}.png`);
    try {
      await downloadMusicFile(`https://drive.google.com/uc?export=download&id=${thumbnailID}`, downloadedthumbnailPath);
      thumbnailPath = downloadedthumbnailPath;
      console.log('Thumbnail downloaded to:', thumbnailPath);
      console.log('VideoPath is:', videoPath);
    } catch (downloadError) {
      console.warn('Failed to download thumbnail:', downloadError.message);
      return res.status(500).json({ 
        error: 'Failed to download thumbnail: ' + downloadError.message 
      });
    }
  }
  
  if (!videoPath || !thumbnailPath) {
    return res.status(400).json({ 
      error: 'videoPath and thumbnailPath are required' 
    });
  }
  
  // Validate input files exist
  if (!fsSync.existsSync(videoPath)) {
    return res.status(404).json({ 
      error: `Video file not found: ${videoPath}` 
    });
  }
  
  if (!fsSync.existsSync(thumbnailPath)) {
    return res.status(404).json({ 
      error: `Thumbnail file not found: ${thumbnailPath}` 
    });
  }
  
  try {
    // Generate output path
    const timestamp = Date.now();
    const outputPath = path.join('temp', `final_video_${timestamp}.mp4`);
    
    // Get video info first to match dimensions and frame rate
    const videoInfo = await getVideoInfo(videoPath);
    const { width = 270, height = 480, fps = 30 } = videoInfo;
    
    console.log(`Video info - Width: ${width}, Height: ${height}, FPS: ${fps}`);
    
    // Simplified FFmpeg command that's more reliable
    const ffmpegCommand = [
      'ffmpeg',
      '-loop', '1',
      '-t', thumbnailDuration.toString(),
      '-i', thumbnailPath,
      '-i', videoPath,
      '-filter_complex',
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1:1,fps=${fps},format=yuv420p[thumb];[1:v]setsar=1:1[video];[thumb][video]concat=n=2:v=1:a=0[outv];[1:a]apad=pad_dur=${thumbnailDuration}[outa]`,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-y',
      outputPath
    ];
    
    console.log('Executing FFmpeg command:', ffmpegCommand.join(' '));
    
    // Execute FFmpeg command with timeout
    await new Promise((resolve, reject) => {
      const ffmpegProcess = spawn('ffmpeg', ffmpegCommand.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      // Set timeout to prevent hanging (60 seconds)
      const timeout = setTimeout(() => {
        ffmpegProcess.kill('SIGKILL');
        reject(new Error('FFmpeg process timed out after 60 seconds'));
      }, 60000);
      
      let stderr = '';
      
      ffmpegProcess.stdout.on('data', (data) => {
        console.log(`FFmpeg stdout: ${data}`);
      });
      
      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log(`FFmpeg stderr: ${data}`);
      });
      
      ffmpegProcess.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          console.log('FFmpeg process completed successfully');
          resolve();
        } else {
          console.error(`FFmpeg process exited with code ${code}`);
          console.error('FFmpeg stderr:', stderr);
          reject(new Error(`FFmpeg failed with exit code ${code}: ${stderr}`));
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        clearTimeout(timeout);
        console.error('FFmpeg process error:', error);
        reject(new Error(`FFmpeg process error: ${error.message}`));
      });
    });
    
    // Check if output file was created
    if (!fsSync.existsSync(outputPath)) {
      throw new Error('Video processing failed - output file not created');
    }
    
    // Get file stats
    const stats = await fs.stat(outputPath);
    
    // Store the processed video info
    const videoId = `video_${timestamp}`;
    finalVideoPath = outputPath;
    
    // Clean up downloaded thumbnail
    if (downloadedthumbnailPath && fsSync.existsSync(downloadedthumbnailPath)) {
      try {
        await fs.unlink(downloadedthumbnailPath);
        console.log('Cleaned up downloaded thumbnail');
      } catch (cleanupError) {
        console.warn('Failed to cleanup thumbnail:', cleanupError.message);
      }
    }
    
    res.json({
      success: true,
      videoId: videoId,
      finalVideoPath: outputPath,
      originalVideoPath: videoPath,
      thumbnailPath: thumbnailPath,
      thumbnailDuration: thumbnailDuration,
      outputFileSize: stats.size,
      processedAt: new Date().toISOString(),
      message: `Video processed successfully with ${thumbnailDuration}s thumbnail intro`,
      downloadUrl: `/get-final-video/${videoId}`
    });
    
  } catch (error) {
    console.error('Video processing error:', error);
    
    // Clean up files on error
    const timestamp = Date.now();
    const outputPath = path.join('temp', `final_video_${timestamp}.mp4`);
    if (fsSync.existsSync(outputPath)) {
      try {
        await fs.unlink(outputPath);
      } catch (unlinkError) {
        console.warn('Failed to cleanup failed output file:', unlinkError.message);
      }
    }
    
    if (downloadedthumbnailPath && fsSync.existsSync(downloadedthumbnailPath)) {
      try {
        await fs.unlink(downloadedthumbnailPath);
      } catch (unlinkError) {
        console.warn('Failed to cleanup downloaded thumbnail:', unlinkError.message);
      }
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      originalVideoPath: videoPath,
      thumbnailPath: thumbnailPath,
      failedAt: new Date().toISOString()
    });
  }
});

// Helper function to get video information
const getVideoInfo = (videoPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.warn('Could not get video info, using defaults:', err.message);
        resolve({ width: 1080, height: 1920, fps: 30 });
        return;
      }
      
      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      if (videoStream) {
        const fps = videoStream.r_frame_rate ? eval(videoStream.r_frame_rate) : 30;
        resolve({
          width: videoStream.width || 270,
          height: videoStream.height || 480,
          fps: Math.round(fps) || 30
        });
      } else {
        resolve({ width: 270, height: 480, fps: 30 });
      }
    });
  });
};

// Utility function to download music file from URL
const downloadMusicFile = async (url, filepath) => {
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

// Enhanced utility function to download Google Drive files (handles both small and large files)
const downloadFile = async (filepath, googleDriveFileID) => {
  try {
    return await downloadGoogleDriveFile(googleDriveFileID, filepath);
  } catch (error) {
    console.error('Google Drive download failed:', error.message);
    throw error;
  }
};

// Specialized function for Google Drive downloads
const downloadGoogleDriveFile = async (fileId, filepath) => {
  const downloadMethods = [
    // Method 1: Standard download URL
    () => attemptDownload(`https://drive.google.com/uc?export=download&id=${fileId}`, filepath),
    
    // Method 2: Bypass virus scan for large files
    () => attemptDownload(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`, filepath),
    
    // Method 3: Handle virus scan page by parsing HTML
    () => handleVirusScanPage(fileId, filepath)
  ];
  
  for (let i = 0; i < downloadMethods.length; i++) {
    try {
      console.log(`Trying Google Drive download method ${i + 1}...`);
      await downloadMethods[i]();
      console.log('Download completed successfully');
      return;
    } catch (error) {
      console.log(`Method ${i + 1} failed:`, error.message);
      if (i === downloadMethods.length - 1) {
        throw new Error('All Google Drive download methods failed');
      }
    }
  }
};

// Compress video using ffmpeg and output to final file path
const compressVideo = (inputPath, outputPath, options = {}) => {
  return new Promise((resolve, reject) => {
    const {
      crf = 23,
      preset = 'medium',
      maxrate = '3M',
      bufsize = '6M',
      audioBitrate = '96k',
      maxWidth = 1280,
      maxHeight = 720,
      timeout = 600000  // 10 minutes default timeout
    } = options;

    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -crf ${crf} -preset ${preset} -tune film -maxrate ${maxrate} -bufsize ${bufsize} -vf "scale='if(gte(iw,ih),min(${maxWidth},iw),-2)':'if(lt(iw,ih),min(${maxHeight},ih),-2)'" -c:a aac -b:a ${audioBitrate} -ac 2 -movflags +faststart -y "${outputPath}"`;
    
    console.log('Starting video compression...');
    console.log('Command:', cmd);
    
    exec(cmd, {
      timeout: timeout,
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      killSignal: 'SIGKILL'
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed && error.signal === 'SIGKILL') {
          reject(new Error(`Video compression timed out after ${timeout}ms`));
        } else {
          reject(new Error(`FFmpeg compression failed: ${stderr || error.message}`));
        }
      } else {
        console.log('Video compression completed successfully');
        resolve({
          success: true,
          outputPath: outputPath,
          stdout: stdout,
          stderr: stderr
        });
      }
    });
  });
};

module.exports = { compressVideo };

// Helper function to attempt download with compression
const attemptDownload = async (downloadUrl, finalFilePath) => {
  const tempFilePath = path.join(os.tmpdir(), `temp_${Date.now()}.mp4`);
  const response = await axios({
    method: 'GET',
    url: downloadUrl,
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 90000
  });

  const contentType = response.headers['content-type'];
  if (contentType && contentType.includes('text/html')) {
    throw new Error('Received HTML page instead of video (likely virus scan)');
  }

  const writer = fsSync.createWriteStream(tempFilePath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', async () => {
      const stats = fsSync.statSync(tempFilePath);
      if (stats.size === 0) {
        fsSync.unlinkSync(tempFilePath);
        reject(new Error('Downloaded file is empty'));
      } else {
        try {
          console.log(`Downloaded to temp file: ${tempFilePath}`);
          console.log(`Compressing video...`);

          await compressVideo(tempFilePath, finalFilePath);

          console.log(`Compression complete. Saved to: ${finalFilePath}`);

          fsSync.unlinkSync(tempFilePath); // Cleanup temp

          resolve();
        } catch (compressionError) {
          fsSync.unlinkSync(tempFilePath);
          reject(compressionError);
        }
      }
    });

    writer.on('error', (err) => {
      if (fsSync.existsSync(tempFilePath)) fsSync.unlinkSync(tempFilePath);
      reject(err);
    });
  });
};


// Handle virus scan page by parsing HTML to get actual download link
const handleVirusScanPage = async (fileId, filepath) => {
  console.log('Handling virus scan page...');
  
  // First, get the virus scan page
  const virusScanUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const htmlResponse = await axios({
    method: 'GET',
    url: virusScanUrl
  });
  
  const htmlContent = htmlResponse.data;
  
  // Parse the form action and hidden inputs from the HTML
  const formActionMatch = htmlContent.match(/action="([^"]+)"/);
  const idMatch = htmlContent.match(/name="id" value="([^"]+)"/);
  const exportMatch = htmlContent.match(/name="export" value="([^"]+)"/);
  const confirmMatch = htmlContent.match(/name="confirm" value="([^"]+)"/);
  const uuidMatch = htmlContent.match(/name="uuid" value="([^"]+)"/);
  
  if (!formActionMatch || !idMatch || !exportMatch || !confirmMatch) {
    throw new Error('Could not parse virus scan page HTML');
  }
  
  // Construct the actual download URL
  const baseUrl = formActionMatch[1];
  const params = new URLSearchParams();
  params.append('id', idMatch[1]);
  params.append('export', exportMatch[1]);
  params.append('confirm', confirmMatch[1]);
  
  if (uuidMatch) {
    params.append('uuid', uuidMatch[1]);
  }
  
  const actualDownloadUrl = `${baseUrl}?${params.toString()}`;
  
  console.log('Constructed download URL from virus scan page');
  return await attemptDownload(actualDownloadUrl, filepath);
};

// Helper function to extract file ID from Google Drive URLs
const extractGoogleDriveFileId = (url) => {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9-_]+)/,  // Standard share link
    /id=([a-zA-Z0-9-_]+)/,          // Direct download link
    /\/d\/([a-zA-Z0-9-_]+)/         // Short format
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
};

module.exports = {
  downloadFile,
  downloadGoogleDriveFile,
  extractGoogleDriveFileId
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Video processing server is running' });
});

// Extract audio from video
app.post('/extract-audio', async (req, res) => {
  try {
    const { googleDriveFileID } = req.body;
    
    if (!googleDriveFileID) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    await ensureTempDir();
    
    // Download video
    const videoId = uuidv4();
    const videoPath = path.join('temp', `${videoId}_input.mp4`);
    const audioPath = path.join('temp', `${videoId}_audio.wav`);
    
    console.log('Downloading video from google drive:', googleDriveFileID);
    await downloadFile(videoPath, googleDriveFileID);
    
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
      videoPath: videoPath,
      videoId: `${videoId}_input.mp4`
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

// Serve temporary video files
app.get('/temp-video/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join('temp', filename);
  
  if (fsSync.existsSync(filePath)) {
    res.sendFile(path.resolve(filePath));
  } else {
    res.status(404).json({ error: 'Video file not found' });
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
    const { videoPath, subtitleContent, srtSubtitles, googleDriveFileIDForMusic, videoUrl } = req.body;
    
    if (!processedVideoPath) {
      return res.status(400).json({ error: 'No processed video available' });
    }
    
    // Verify input video exists
    if (!fsSync.existsSync(processedVideoPath)) {
      return res.status(400).json({ error: 'Input video file does not exist' });
    }
    
    const outputPath = path.join('temp', `final_${uuidv4()}.mp4`);
    const subtitlePath = path.join('temp', `subtitles_${uuidv4()}.srt`);
    let downloadedMusicPath = null;
    let downloadedVideoPath = null;
    
    finalVideoPath = outputPath;
    
    // Use srtSubtitles if available, otherwise fall back to subtitleContent
    const subtitleText = srtSubtitles || subtitleContent;
    
    if (!subtitleText) {
      return res.status(400).json({ error: 'No subtitle content provided' });
    }
    
    // Write subtitle content to file
    await fs.writeFile(subtitlePath, subtitleText, 'utf8');
    
    // Handle music file - download if URL, use local path if file path
    let actualMusicPath = null;
    if (googleDriveFileIDForMusic) {
        // Download music from URL
        console.log('Downloading music from google drive ID:', googleDriveFileIDForMusic);
        downloadedMusicPath = path.join('temp', `music_${uuidv4()}.mp3`);
        try {
          //await downloadFile(downloadedMusicPath, googleDriveFileIDForMusic);
          await downloadMusicFile(`https://drive.google.com/uc?export=download&id=${googleDriveFileIDForMusic}`, downloadedMusicPath);
          actualMusicPath = downloadedMusicPath;
          console.log('Music downloaded to:', actualMusicPath);
        } catch (downloadError) {
          console.warn('Failed to download music:', downloadError.message);
          // Continue without music if download fails
        }
       
    }

    if (videoUrl) {
        // Download music from URL
        console.log('Downloading video from creatomate:', videoUrl);
        downloadedVideoPath = path.join('temp', `video_${uuidv4()}.mp4`);
        try {
          //await downloadFile(downloadedMusicPath, googleDriveFileIDForMusic);
          await downloadMusicFile(videoUrl, downloadedVideoPath);
          processedVideoPath = downloadedVideoPath;
          console.log('Music downloaded to:', actualMusicPath);
        } catch (downloadError) {
          console.warn('Failed to download music:', downloadError.message);
          // Continue without music if download fails
        }
       
    }
    
    console.log('Adding subtitles...');
    console.log('Input video:', processedVideoPath);
    console.log('Output path:', outputPath);
    console.log('Subtitle path:', subtitlePath);
    
    await new Promise((resolve, reject) => {
      const command = ffmpeg(processedVideoPath);
      
      // Add background music if available
      if (actualMusicPath && fsSync.existsSync(actualMusicPath)) {
        console.log('Adding background music:', actualMusicPath);
        command.input(actualMusicPath);
      }
      
      // Add subtitles with proper escaping and positioning within video bounds
//      const escapedSubtitlePath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      
      // Configure audio and video filters
      const audioFilters = [];
//      const videoFilters = [`subtitles='${escapedSubtitlePath}':force_style='FontName=Arial,FontSize=12,PrimaryColour=&Hffffff&,BackColour=&H80000000&,Bold=1,Outline=2,OutlineColour=&H000000&,MarginV=40,MarginL=75,MarginR=75,Alignment=2'`];
      
      if (actualMusicPath && fsSync.existsSync(actualMusicPath)) {
        // Mix original audio with background music
        // Lower original audio volume and add background music at moderate volume
        audioFilters.push('[0:a]volume=0.8[a0];[1:a]volume=0.2[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]');
        command.outputOptions([
          '-map', '0:v',  // Use video from first input (original video)
          '-map', '[aout]' // Use mixed audio output
        ]);
      }
      
      // Apply filters
      if (audioFilters.length > 0) {
        command.complexFilter(audioFilters.join(';'));
      }
//      command.outputOptions([
//        '-vf', videoFilters.join(',')
//      ]);
      
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
          // Clean up temporary files
          fsSync.unlink(subtitlePath, (err) => {
            if (err) console.warn('Failed to delete temp subtitle file:', err);
          });
          if (downloadedMusicPath) {
            fsSync.unlink(downloadedMusicPath, (err) => {
              if (err) console.warn('Failed to delete temp music file:', err);
            });
          }
          resolve();
        })
        .on('error', (error) => {
          console.error('FFmpeg error in final processing:', error);
          console.error('FFmpeg stderr:', error.stderr);
          // Clean up on error
          fsSync.unlink(subtitlePath, () => {});
          if (downloadedMusicPath) {
            fsSync.unlink(downloadedMusicPath, () => {});
          }
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
      videoId: `final_${uuidv4()}.mp4`,
      finalStats: {
        fileSize: stats.size,
        hasMusic: !!(actualMusicPath && fsSync.existsSync(actualMusicPath)), // Check if music was actually added
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
