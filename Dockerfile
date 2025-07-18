FROM node:18-slim

# Install FFmpeg and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Create temp directory with proper permissions
RUN mkdir -p temp && chmod 755 temp

# Use Railway's PORT environment variable
ENV PORT=3001

EXPOSE $PORT

CMD ["node", "server.js"]
