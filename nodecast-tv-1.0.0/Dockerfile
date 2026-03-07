FROM node:20-alpine

# Install build dependencies for better-sqlite3 and FFmpeg for streaming
# Using system FFmpeg instead of ffmpeg-static for better Docker DNS compatibility
RUN apk add --no-cache python3 make g++ ffmpeg

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server/index.js"]
