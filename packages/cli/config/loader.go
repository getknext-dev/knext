package config

import (
	"encoding/json"
	"fmt"
	"os/exec"
)

// LoadConfig executes the helper script to evaluate TS config and returns the struct
func LoadConfig(scriptPath, workDir string) (*Config, error) {
	cmd := exec.Command("bun", "run", scriptPath)
    cmd.Dir = workDir
	output, err := cmd.Output()
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("config loader failed: %s\nStderr: %s", err, string(exitError.Stderr))
		}
		return nil, fmt.Errorf("failed to run config loader: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(output, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config json: %w", err)
	}

	return &cfg, nil
}
