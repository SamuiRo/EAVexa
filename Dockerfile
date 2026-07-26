# Base image ships Chromium already matching this exact Playwright version —
# no `npx playwright install` needed at build time. Bump the tag if you bump
# the `playwright` dependency in package.json.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    EAVEXA_HOST=0.0.0.0 \
    EAVEXA_PORT=8080 \
    CHROME_SANDBOX=auto

EXPOSE 8080

CMD ["node", "src/cli/cli.js", "serve"]
