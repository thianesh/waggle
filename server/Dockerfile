FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
ENV DATA_DIR=/data \
    PORT=8787
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
