package main

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/DnzzL/herdr-automations/internal/config"
)

const maxRunInput = 1024 * 1024

var argumentPattern = regexp.MustCompile(`\{argument\s+name="([^"{}]+)"\s*\}`)

// decodeRunArguments accepts only bounded literal values; no file/shell expansion.
func decodeRunArguments(in io.Reader) (map[string]string, error) {
	data, err := io.ReadAll(io.LimitReader(in, maxRunInput+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRunInput {
		return nil, fmt.Errorf("argument input exceeds 1 MiB")
	}
	var values map[string]string
	if err = json.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("read arguments JSON: %w", err)
	}
	if values == nil {
		return nil, fmt.Errorf("arguments must be a JSON object")
	}
	return values, nil
}

// applyRunArguments changes only this run's copy. Scheduled prompts stay literal.
func applyRunArguments(a config.Automation, values map[string]string) (config.Automation, error) {
	if !a.Manual {
		if values != nil {
			return a, fmt.Errorf("argument values are only supported for manual automations")
		}
		return a, nil
	}
	matches := argumentPattern.FindAllStringSubmatchIndex(a.Prompt, -1)
	names := map[string]bool{}
	cursor := 0
	var out strings.Builder
	for _, m := range matches {
		literal := a.Prompt[cursor:m[0]]
		if strings.Contains(literal, "{argument") {
			return a, fmt.Errorf("invalid argument placeholder; use {argument name=\"Name\"}")
		}
		name := a.Prompt[m[2]:m[3]]
		if strings.TrimSpace(name) == "" {
			return a, fmt.Errorf("argument placeholder needs a name")
		}
		value, exists := values[name]
		if !exists || strings.TrimSpace(value) == "" {
			return a, fmt.Errorf("enter %s using --arguments-stdin", name)
		}
		names[name] = true
		out.WriteString(literal)
		out.WriteString(value)
		cursor = m[1]
	}
	tail := a.Prompt[cursor:]
	if strings.Contains(tail, "{argument") {
		return a, fmt.Errorf("invalid argument placeholder; use {argument name=\"Name\"}")
	}
	for name := range values {
		if !names[name] {
			return a, fmt.Errorf("unknown argument: %s", name)
		}
	}
	out.WriteString(tail)
	a.Prompt = out.String()
	return a, nil
}

func runInput(args []string, in io.Reader) ([]string, map[string]string, error) {
	rest, provided := withoutFlag(args, "--arguments-stdin")
	if !provided {
		return rest, nil, nil
	}
	values, err := decodeRunArguments(in)
	return rest, values, err
}

func selectedRun(name string, values map[string]string) (config.Automation, error) {
	cfg, err := config.Load()
	if err != nil {
		return config.Automation{}, err
	}
	a := cfg.Find(name)
	if a == nil {
		if d := cfg.Diagnostic(name); d != nil {
			return config.Automation{}, fmt.Errorf("%s did not load: %s", name, d)
		}
		return config.Automation{}, fmt.Errorf("no automation named %q", name)
	}
	if a.Disabled {
		return *a, fmt.Errorf("%s is inactive; activate it before running", a.Name)
	}
	return applyRunArguments(*a, values)
}
