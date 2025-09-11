# Use Node.js 20 Alpine for building
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (skip postinstall scripts like husky)
RUN npm ci --omit=dev --ignore-scripts

# Copy source code
COPY . .

# Build the static site
RUN npm run build

# Use nginx to serve static files
FROM nginx:alpine

# Copy built site from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Copy custom nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

# Expose port 8080 (Fly.io default)
EXPOSE 8080

# Start nginx
CMD ["nginx", "-g", "daemon off;"]