# ---- Build stage ----
FROM golang:1.22-alpine AS build

WORKDIR /app

# Copy the module definition first for better layer caching, then resolve deps.
COPY go.mod ./
RUN go mod download github.com/gorilla/websocket || true

# Copy the sources and let `go mod tidy` produce a valid go.sum.
COPY *.go ./
RUN go mod tidy

# Build a static binary.
RUN CGO_ENABLED=0 GOOS=linux go build -o /partymusic .

# ---- Runtime stage ----
FROM alpine:3.19

WORKDIR /app
COPY --from=build /partymusic /app/partymusic

# Default music directory (overridable via env / volume mount).
ENV MUSIC_DIR=/app/music
ENV LISTEN_ADDR=:8080
RUN mkdir -p /app/music

EXPOSE 8080
ENTRYPOINT ["/app/partymusic"]
