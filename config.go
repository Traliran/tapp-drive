package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type ProtectedFolder struct {
	Path     string `json:"path"`
	Password string `json:"password"`
}

type Config struct {
	StorageDir       string            `json:"storage_dir"`
	Listen           string            `json:"listen"`
	ProtectedFolders []ProtectedFolder `json:"protected_folders"`
}

func LoadConfig(filename string) (*Config, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("parse config: unexpected data after JSON object")
	}

	if strings.TrimSpace(cfg.StorageDir) == "" {
		return nil, fmt.Errorf("config: storage_dir is required")
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8080"
	}

	storageDir := cfg.StorageDir
	if !filepath.IsAbs(storageDir) {
		storageDir = filepath.Join(filepath.Dir(filename), storageDir)
	}
	storageDir, err = filepath.Abs(storageDir)
	if err != nil {
		return nil, fmt.Errorf("config: resolve storage_dir: %w", err)
	}
	if err := os.MkdirAll(storageDir, 0o755); err != nil {
		return nil, fmt.Errorf("config: create storage_dir: %w", err)
	}
	info, err := os.Stat(storageDir)
	if err != nil {
		return nil, fmt.Errorf("config: stat storage_dir: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("config: storage_dir is not a directory")
	}
	cfg.StorageDir = storageDir

	seen := make(map[string]bool, len(cfg.ProtectedFolders))
	for i := range cfg.ProtectedFolders {
		raw := strings.TrimSpace(cfg.ProtectedFolders[i].Path)
		if raw == "" {
			return nil, fmt.Errorf("config: protected_folders[%d].path is required", i)
		}
		if strings.HasPrefix(raw, "/") {
			return nil, fmt.Errorf("config: protected folder path %q must be relative", raw)
		}
		clean := path.Clean(strings.ReplaceAll(raw, "\\", "/"))
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
			return nil, fmt.Errorf("config: invalid protected folder path %q", raw)
		}
		if cfg.ProtectedFolders[i].Password == "" {
			return nil, fmt.Errorf("config: protected folder %q has an empty password", clean)
		}
		if seen[clean] {
			return nil, fmt.Errorf("config: duplicate protected folder %q", clean)
		}
		seen[clean] = true
		cfg.ProtectedFolders[i].Path = clean
	}

	return &cfg, nil
}
