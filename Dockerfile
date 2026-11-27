# syntax=docker/dockerfile:1
FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/drive-app .

FROM scratch

COPY --from=build /out/drive-app /drive-app
COPY config.example.json /config.example.json

EXPOSE 8080
ENTRYPOINT ["/drive-app"]
CMD ["-config", "/config/config.json"]
