FROM node:22-alpine
WORKDIR /app
COPY package.json server.js giveaway.js platforms.js apns.js ./
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV CONFIG=/data/config.json
EXPOSE 8080
CMD ["node", "server.js"]
