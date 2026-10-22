FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV TZ=Europe/London
RUN apk add --no-cache tzdata
EXPOSE 8099
CMD ["node", "--experimental-sqlite", "--no-warnings", "server.js"]
