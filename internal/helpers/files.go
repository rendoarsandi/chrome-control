package helpers

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"

	"github.com/rendoarsandi/chrome-control/internal/errs"
)

const (
	MaxFileBytes  = 65536
	MaxTotalBytes = 131072
)

// HelperSource represents one assistant-authored JS helper file loaded from disk.
type HelperSource struct {
	Path string
	Code string
	Hash string
}

// LoadHelperFiles reads explicitly configured assistant-authored helper files with strict bounds.
func LoadHelperFiles(paths []string) ([]HelperSource, error) {
	seen := make(map[string]bool, len(paths))
	var sources []HelperSource
	total := 0

	for _, p := range paths {
		if seen[p] {
			continue
		}
		seen[p] = true
		if !filepath.IsAbs(p) {
			return nil, errs.New(
				"HELPER_PATH_INVALID",
				"Helper paths must be absolute.",
				"Use an absolute path to an assistant-authored JavaScript file.",
				nil,
			)
		}
		f, err := os.Open(p)
		if err != nil {
			return nil, errs.New(
				"HELPER_FILE_UNAVAILABLE",
				"Could not read helper file: "+p,
				"Check the file path and host filesystem permissions.",
				nil,
			)
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, errs.New(
				"HELPER_FILE_UNAVAILABLE",
				"Could not read helper file: "+p,
				"Check the file path and host filesystem permissions.",
				nil,
			)
		}
		if !info.Mode().IsRegular() || info.Size() > MaxFileBytes || int64(total)+info.Size() > MaxTotalBytes {
			f.Close()
			return nil, errs.New(
				"HELPER_FILE_LIMIT",
				"Helpers must be regular files of at most 64 KiB each and 128 KiB total.",
				"Provide smaller helper files.",
				nil,
			)
		}
		data, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
		f.Close()
		if err != nil {
			return nil, errs.New(
				"HELPER_FILE_UNAVAILABLE",
				"Could not read helper file: "+p,
				"Check the file path and host filesystem permissions.",
				nil,
			)
		}
		total += len(data)
		if len(data) > MaxFileBytes || total > MaxTotalBytes {
			return nil, errs.New(
				"HELPER_FILE_LIMIT",
				"Helper files exceed the size limit.",
				"Provide smaller helper files.",
				nil,
			)
		}
		sum := sha256.Sum256(data)
		sources = append(sources, HelperSource{
			Path: p,
			Code: string(data),
			Hash: hex.EncodeToString(sum[:]),
		})
	}
	return sources, nil
}
