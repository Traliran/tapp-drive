package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
)

var (
	errUnauthorized = errors.New("password required")
	errInvalidPath  = errors.New("invalid path")
)

func cleanRel(rel string) (string, error) {
	if strings.ContainsRune(rel, '\x00') {
		return "", errInvalidPath
	}
	rel = strings.TrimLeft(rel, "/")
	for _, segment := range strings.Split(rel, "/") {
		if segment == ".." {
			return "", errInvalidPath
		}
	}
	clean := path.Clean(rel)
	if clean == "." {
		return "", nil
	}
	if clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") {
		return "", errInvalidPath
	}
	return clean, nil
}

func withinRoot(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (s *Server) safePath(rel string) (string, error) {
	clean, err := cleanRel(rel)
	if err != nil {
		return "", err
	}
	full := filepath.Join(s.root, filepath.FromSlash(clean))
	if !withinRoot(s.root, full) {
		return "", errInvalidPath
	}
	return full, nil
}

// verifiedPath returns the original path (not the symlink target) after
// confirming that any symlinks in it stay inside the storage root.
func (s *Server) verifiedPath(rel string) (string, error) {
	full, err := s.safePath(rel)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", err
	}
	if !withinRoot(s.root, real) {
		return "", errInvalidPath
	}
	return full, nil
}

func (s *Server) existingPath(rel string) (string, error) {
	full, err := s.safePath(rel)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", err
	}
	if !withinRoot(s.root, real) {
		return "", errInvalidPath
	}
	return real, nil
}

// resolveCreate returns a safe absolute path for a file or directory that does
// not necessarily exist yet. Any existing ancestor is checked for symlink
// escapes, and an existing target is resolved and checked as well.
func (s *Server) resolveCreate(rel string) (string, error) {
	full, err := s.safePath(rel)
	if err != nil {
		return "", err
	}
	if full == s.root {
		return "", errInvalidPath
	}

	if _, err := os.Lstat(full); err == nil {
		real, err := filepath.EvalSymlinks(full)
		if err != nil {
			return "", err
		}
		if !withinRoot(s.root, real) {
			return "", errInvalidPath
		}
		return real, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}

	ancestor := filepath.Dir(full)
	for {
		real, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			if !withinRoot(s.root, real) {
				return "", errInvalidPath
			}
			extra, err := filepath.Rel(ancestor, full)
			if err != nil {
				return "", err
			}
			target := filepath.Join(real, extra)
			if !withinRoot(s.root, target) {
				return "", errInvalidPath
			}
			return target, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			break
		}
		ancestor = parent
	}
	return "", fmt.Errorf("cannot resolve path")
}

func sanitizeUploadName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	if name == "" || name == "." || name == ".." {
		return ""
	}
	return name
}

func copyPath(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		link, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(link, dst)
	}
	if info.IsDir() {
		if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyPath(filepath.Join(src, entry.Name()), filepath.Join(dst, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	return copyFile(src, dst, info.Mode().Perm())
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	return nil
}

func movePath(src, dst string) error {
	if err := os.Rename(src, dst); err != nil {
		if !errors.Is(err, syscall.EXDEV) {
			return err
		}
		if err := copyPath(src, dst); err != nil {
			return err
		}
		return os.RemoveAll(src)
	}
	return nil
}

func diskUsage(root string) (free, total uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(root, &stat); err != nil {
		return 0, 0, err
	}
	blockSize := uint64(stat.Bsize)
	return stat.Bavail * blockSize, stat.Blocks * blockSize, nil
}
