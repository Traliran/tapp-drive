package main

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed web
var embeddedWeb embed.FS

type Server struct {
	cfg       *Config
	root      string
	protected []ProtectedFolder
	web       fs.FS
}

func NewServer(cfg *Config) (*Server, error) {
	root, err := filepath.EvalSymlinks(cfg.StorageDir)
	if err != nil {
		return nil, fmt.Errorf("resolve storage directory: %w", err)
	}
	web, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, fmt.Errorf("load embedded web assets: %w", err)
	}
	return &Server{
		cfg:       cfg,
		root:      root,
		protected: cfg.ProtectedFolders,
		web:       web,
	}, nil
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /static/{file}", s.handleStatic)
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("POST /api/check-password", s.handleCheckPassword)
	mux.HandleFunc("GET /api/list", s.handleList)
	mux.HandleFunc("GET /api/raw/{path...}", func(w http.ResponseWriter, r *http.Request) {
		s.serveFile(w, r, false)
	})
	mux.HandleFunc("GET /api/download/{path...}", func(w http.ResponseWriter, r *http.Request) {
		s.serveFile(w, r, true)
	})
	mux.HandleFunc("POST /api/upload", s.handleUpload)
	mux.HandleFunc("POST /api/save-text", s.handleSaveText)
	mux.HandleFunc("POST /api/mkdir", s.handleMkdir)
	mux.HandleFunc("POST /api/move", func(w http.ResponseWriter, r *http.Request) {
		s.handleBulk(w, r, false)
	})
	mux.HandleFunc("POST /api/copy", func(w http.ResponseWriter, r *http.Request) {
		s.handleBulk(w, r, true)
	})
	mux.HandleFunc("DELETE /api/delete", s.handleDelete)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(s.web, "index.html")
	if err != nil {
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https: http:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
	w.Write(data)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	switch name {
	case "app.css", "app.js":
	default:
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(s.web, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := "text/css; charset=utf-8"
	if name == "app.js" {
		contentType = "text/javascript; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(data)
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	folders := make([]string, 0, len(s.protected))
	for _, folder := range s.protected {
		folders = append(folders, folder.Path)
	}
	free, total, err := diskUsage(s.root)
	if err != nil {
		log.Printf("disk usage: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"protected_folders": folders,
		"free_gb":           round2(float64(free) / (1024 * 1024 * 1024)),
		"total_gb":          round2(float64(total) / (1024 * 1024 * 1024)),
	})
}

func (s *Server) handleCheckPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path     string `json:"path"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	rel, err := cleanRel(req.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	folder := s.protectionFor(rel)
	if folder == nil {
		writeError(w, http.StatusBadRequest, "path is not protected")
		return
	}
	if !passwordMatches(folder, req.Password) {
		writeError(w, http.StatusUnauthorized, "wrong password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	rel, err := cleanRel(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	if err := s.authorize(r, rel, nil); err != nil {
		writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
		return
	}

	target, err := s.existingPath(rel)
	if err != nil {
		writeFileError(w, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is not a folder")
		return
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		writeFileError(w, err)
		return
	}

	type listItem struct {
		Name    string `json:"name"`
		IsDir   bool   `json:"is_dir"`
		RelPath string `json:"rel_path"`
		Mtime   int64  `json:"mtime"`
		Size    int64  `json:"size"`
	}
	items := make([]listItem, 0, len(entries))
	for _, entry := range entries {
		full := filepath.Join(target, entry.Name())
		real, err := filepath.EvalSymlinks(full)
		if err != nil || !withinRoot(s.root, real) {
			continue
		}
		entryInfo, err := os.Stat(full)
		if err != nil {
			continue
		}
		realRel, err := filepath.Rel(s.root, real)
		if err != nil {
			continue
		}
		realRel = filepath.ToSlash(realRel)
		logicalRel := path.Join(rel, entry.Name())
		if s.protectionFor(realRel) != nil && s.protectionFor(logicalRel) == nil {
			continue
		}
		items = append(items, listItem{
			Name:    entry.Name(),
			IsDir:   entryInfo.IsDir(),
			RelPath: logicalRel,
			Mtime:   entryInfo.ModTime().Unix(),
			Size:    entryInfo.Size(),
		})
	}

	sortBy := r.URL.Query().Get("sort")
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}
		left, right := strings.ToLower(items[i].Name), strings.ToLower(items[j].Name)
		switch sortBy {
		case "name-desc":
			return left > right
		case "date-desc":
			return items[i].Mtime > items[j].Mtime
		case "date-asc":
			return items[i].Mtime < items[j].Mtime
		default:
			return left < right
		}
	})

	writeJSON(w, http.StatusOK, items)
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, download bool) {
	rel, err := cleanRel(r.PathValue("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	if err := s.authorize(r, rel, nil); err != nil {
		writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
		return
	}
	target, err := s.existingPath(rel)
	if err != nil {
		writeFileError(w, err)
		return
	}
	info, err := os.Stat(target)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	if download {
		disposition := mime.FormatMediaType("attachment", map[string]string{"filename": info.Name()})
		w.Header().Set("Content-Disposition", disposition)
	}
	w.Header().Set("Content-Security-Policy", "script-src 'none'; object-src 'none'")
	http.ServeFile(w, r, target)
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	rel := ""
	havePath := false
	if values, ok := r.URL.Query()["path"]; ok {
		rel = values[0]
		havePath = true
	}
	if _, err := cleanRel(rel); err != nil {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}

	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "expected multipart form data")
		return
	}

	wrote := false
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid multipart form data")
			return
		}

		switch part.FormName() {
		case "path":
			if !havePath {
				data, err := io.ReadAll(io.LimitReader(part, 1<<20))
				if err != nil {
					part.Close()
					writeError(w, http.StatusBadRequest, "invalid path field")
					return
				}
				rel = string(data)
				havePath = true
			}
			part.Close()

		case "file":
			if !havePath {
				part.Close()
				writeError(w, http.StatusBadRequest, "path must be sent before the file")
				return
			}
			cleanTarget, err := cleanRel(rel)
			if err != nil {
				part.Close()
				writeError(w, http.StatusBadRequest, errInvalidPath.Error())
				return
			}
			if err := s.authorize(r, cleanTarget, nil); err != nil {
				part.Close()
				writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
				return
			}
			targetDir, err := s.existingPath(cleanTarget)
			if err != nil {
				part.Close()
				writeFileError(w, err)
				return
			}
			dirInfo, err := os.Stat(targetDir)
			if err != nil {
				part.Close()
				writeFileError(w, err)
				return
			}
			if !dirInfo.IsDir() {
				part.Close()
				writeError(w, http.StatusBadRequest, "upload target is not a folder")
				return
			}

			name := sanitizeUploadName(part.FileName())
			if name == "" {
				part.Close()
				writeError(w, http.StatusBadRequest, "invalid file name")
				return
			}
			dst, err := s.resolveCreate(path.Join(cleanTarget, name))
			if err != nil {
				part.Close()
				writeFileError(w, err)
				return
			}
			if info, err := os.Stat(dst); err == nil && info.IsDir() {
				part.Close()
				writeError(w, http.StatusConflict, "a folder with that name already exists")
				return
			}

			out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				part.Close()
				writeFileError(w, err)
				return
			}
			_, copyErr := io.Copy(out, part)
			closeErr := out.Close()
			part.Close()
			if copyErr != nil {
				os.Remove(dst)
				writeFileError(w, copyErr)
				return
			}
			if closeErr != nil {
				os.Remove(dst)
				writeFileError(w, closeErr)
				return
			}
			wrote = true

		default:
			part.Close()
		}
	}

	if !wrote {
		writeError(w, http.StatusBadRequest, "no file uploaded")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSaveText(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := decodeJSON(w, r, &req, 16<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	rel, err := cleanRel(req.Path)
	if err != nil || rel == "" {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	if err := s.authorize(r, rel, nil); err != nil {
		writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
		return
	}
	target, err := s.resolveCreate(rel)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		writeError(w, http.StatusConflict, "path is a folder")
		return
	}
	if err := os.WriteFile(target, []byte(req.Content), 0o644); err != nil {
		writeFileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	rel, err := cleanRel(req.Path)
	if err != nil || rel == "" {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	if err := s.authorize(r, rel, nil); err != nil {
		writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
		return
	}
	target, err := s.resolveCreate(rel)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		writeFileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleBulk(w http.ResponseWriter, r *http.Request, copyItems bool) {
	var req struct {
		Sources   []string          `json:"sources"`
		TargetDir string            `json:"target_dir"`
		Passwords map[string]string `json:"passwords"`
	}
	if err := decodeJSON(w, r, &req, 1<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Sources) == 0 {
		writeError(w, http.StatusBadRequest, "no files selected")
		return
	}
	targetRel, err := cleanRel(req.TargetDir)
	if err != nil {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	if err := s.authorize(r, targetRel, req.Passwords); err != nil {
		writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
		return
	}
	targetDir, err := s.existingPath(targetRel)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if info, err := os.Stat(targetDir); err != nil || !info.IsDir() {
		writeError(w, http.StatusBadRequest, "target is not a folder")
		return
	}

	type operation struct {
		src string
		dst string
	}
	operations := make([]operation, 0, len(req.Sources))
	destinations := make(map[string]bool, len(req.Sources))
	for _, rawSource := range req.Sources {
		sourceRel, err := cleanRel(rawSource)
		if err != nil || sourceRel == "" {
			writeError(w, http.StatusBadRequest, errInvalidPath.Error())
			return
		}
		if err := s.authorize(r, sourceRel, req.Passwords); err != nil {
			writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
			return
		}
		src, err := s.verifiedPath(sourceRel)
		if err != nil {
			writeFileError(w, err)
			return
		}
		srcInfo, err := os.Lstat(src)
		if err != nil {
			writeFileError(w, err)
			return
		}
		dst, err := s.resolveCreate(path.Join(targetRel, srcInfo.Name()))
		if err != nil {
			writeFileError(w, err)
			return
		}
		if src == dst {
			if copyItems {
				writeError(w, http.StatusConflict, fmt.Sprintf("%q already exists in the target folder", srcInfo.Name()))
				return
			}
			continue
		}
		if srcInfo.IsDir() {
			inside, err := filepath.Rel(src, dst)
			if err == nil && inside != ".." && !strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
				writeError(w, http.StatusBadRequest, "cannot copy or move a folder into itself")
				return
			}
		}
		if _, err := os.Lstat(dst); err == nil {
			writeError(w, http.StatusConflict, fmt.Sprintf("%q already exists in the target folder", srcInfo.Name()))
			return
		} else if !os.IsNotExist(err) {
			writeFileError(w, err)
			return
		}
		if destinations[dst] {
			writeError(w, http.StatusConflict, "multiple selected items have the same name")
			return
		}
		destinations[dst] = true
		operations = append(operations, operation{src: src, dst: dst})
	}

	for _, op := range operations {
		var err error
		if copyItems {
			err = copyPath(op.src, op.dst)
		} else {
			err = movePath(op.src, op.dst)
		}
		if err != nil {
			writeFileError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	rel, err := cleanRel(r.URL.Query().Get("path"))
	if err != nil || rel == "" {
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
		return
	}
	if err := s.authorize(r, rel, nil); err != nil {
		writeError(w, http.StatusUnauthorized, errUnauthorized.Error())
		return
	}
	target, err := s.verifiedPath(rel)
	if err != nil {
		writeFileError(w, err)
		return
	}
	if err := os.RemoveAll(target); err != nil {
		writeFileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) protectionFor(rel string) *ProtectedFolder {
	var match *ProtectedFolder
	for i := range s.protected {
		folder := &s.protected[i]
		if rel == folder.Path || strings.HasPrefix(rel, folder.Path+"/") {
			if match == nil || len(folder.Path) > len(match.Path) {
				match = folder
			}
		}
	}
	return match
}

func (s *Server) authorize(r *http.Request, rel string, extra map[string]string) error {
	if err := s.authorizeLogical(r, rel, extra); err != nil {
		return err
	}
	// A symlink must not be a way around a protected folder. Check the real
	// destination path as well, including a not-yet-created file.
	if rel == "" {
		return nil
	}
	real, err := s.resolveCreate(rel)
	if err != nil {
		return nil
	}
	realRel, err := filepath.Rel(s.root, real)
	if err != nil {
		return nil
	}
	realRel = filepath.ToSlash(realRel)
	if realRel == "." || realRel == rel {
		return nil
	}
	return s.authorizeLogical(r, realRel, extra)
}

func (s *Server) authorizeLogical(r *http.Request, rel string, extra map[string]string) error {
	folder := s.protectionFor(rel)
	if folder == nil {
		return nil
	}
	password := ""
	if extra != nil {
		password = extra[folder.Path]
	}
	if password == "" {
		password = r.Header.Get("X-Password")
	}
	if password == "" {
		password = r.URL.Query().Get("password")
	}
	if !passwordMatches(folder, password) {
		return errUnauthorized
	}
	return nil
}

func passwordMatches(folder *ProtectedFolder, password string) bool {
	return subtle.ConstantTimeCompare([]byte(password), []byte(folder.Password)) == 1
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("unexpected data after JSON body")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, map[string]string{"detail": detail})
}

func writeFileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvalidPath):
		writeError(w, http.StatusBadRequest, errInvalidPath.Error())
	case errors.Is(err, os.ErrNotExist):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, os.ErrPermission):
		writeError(w, http.StatusForbidden, "permission denied")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}
