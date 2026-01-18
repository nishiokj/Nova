/**
 * ProvidersView component.
 *
 * Displays and manages provider API keys.
 * Uses bridge client for provider operations.
 * No authentication required - stores API keys directly in config file.
 */

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { exec } from "child_process";
import type { BridgeClient } from "../bridge_client.js";
import { useBracketedPaste } from "../hooks/useBracketedPaste.js";
import { getAllProviders, getProviderDashboardUrl, type ProviderDefinition } from "types";

interface ProviderInfo {
  provider: string;
  configured: boolean;
  updatedAt?: number;
}

interface ProvidersViewProps {
  width: number;
  bridgeClient: BridgeClient;
  onClose: () => void;
}

type ViewMode =
  | { mode: "list" }
  | { mode: "add"; provider: string; input: string; cursor: number }
  | { mode: "confirm_delete"; provider: string }
  | { mode: "testing"; provider: string }
  | { mode: "error"; message: string };

// Derive provider list from central registry
const SUPPORTED_PROVIDERS = getAllProviders().map((p: ProviderDefinition) => ({
  id: p.id,
  name: p.displayName,
}));

/** Strip bracketed paste escape sequences from input */
function stripPasteMarkers(str: string): string {
  return str
    // Full escape sequences
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    // Without escape char (already stripped by control char filter)
    .replace(/\[200~/g, "")
    .replace(/\[201~/g, "")
    // Catch any remaining bracket-number-tilde patterns
    .replace(/\[20[01]~/g, "");
}

export function ProvidersView({ width, bridgeClient, onClose }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>({ mode: "list" });
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Use ref for synchronous paste state tracking (useState is async and causes race conditions)
  const isPastingRef = useRef(false);

  // Handle pasted text properly - only active in "add" mode
  useBracketedPaste({
    onPaste: (text) => {
      if (viewMode.mode === "add") {
        // Clean and store pasted text
        const clean = stripPasteMarkers(text).trim();
        setViewMode({
          ...viewMode,
          input: clean,
          cursor: clean.length,
        });
      }
    },
    onPasteStart: () => { isPastingRef.current = true; },
    onPasteEnd: () => { isPastingRef.current = false; },
    enabled: viewMode.mode === "add",
  });

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    setLoading(true);
    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersList();
      if (result.success && result.providers) {
        setProviders(result.providers);
      } else {
        setMessage({
          text: result.error ?? "Failed to load providers",
          type: "error",
        });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to load providers",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const saveApiKey = async (provider: string, apiKey: string) => {
    const cleanKey = stripPasteMarkers(apiKey).trim();

    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersSave(provider, cleanKey);
      if (result.success) {
        setMessage({ text: `API key saved for ${provider}`, type: "success" });
        await loadProviders();
      } else {
        setMessage({ text: result.error ?? "Failed to save API key", type: "error" });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to save API key",
        type: "error",
      });
    }
    setViewMode({ mode: "list" });
  };

  const deleteApiKey = async (provider: string) => {
    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersDelete(provider);
      if (result.success) {
        setMessage({ text: `API key removed for ${provider}`, type: "success" });
        await loadProviders();
      } else {
        setMessage({ text: result.error ?? "Failed to remove API key", type: "error" });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to remove API key",
        type: "error",
      });
    }
    setViewMode({ mode: "list" });
  };

  const testApiKey = async (provider: string) => {
    setViewMode({ mode: "testing", provider });
    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersTest(provider);
      if (result.valid) {
        setMessage({ text: `${provider} API key is valid`, type: "success" });
      } else {
        setMessage({ text: result.error ?? `${provider} API key is invalid`, type: "error" });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to test API key",
        type: "error",
      });
    }
    setViewMode({ mode: "list" });
  };

  useInput((input, key) => {
    // Clear message on any input
    if (message) {
      setMessage(null);
    }

    if (viewMode.mode === "list") {
      if (key.escape) {
        onClose();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(SUPPORTED_PROVIDERS.length - 1, i + 1));
        return;
      }

      if (key.return || input === "a") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        setViewMode({ mode: "add", provider: provider.id, input: "", cursor: 0 });
        return;
      }

      if (input === "d") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        const providerInfo = providers.find((p) => p.provider === provider.id);
        if (providerInfo?.configured) {
          setViewMode({ mode: "confirm_delete", provider: provider.id });
        }
        return;
      }

      if (input === "t") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        const providerInfo = providers.find((p) => p.provider === provider.id);
        if (providerInfo?.configured) {
          testApiKey(provider.id);
        }
        return;
      }

      if (input === "r") {
        loadProviders();
        return;
      }

      if (input.toLowerCase() === "l") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        const dashboardUrl = getProviderDashboardUrl(provider.id);
        if (dashboardUrl) {
          // Open URL in default browser (cross-platform)
          const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
          exec(`${cmd} "${dashboardUrl}"`);
          setMessage({ text: `Opening ${provider.name} dashboard...`, type: "success" });
        }
        return;
      }
    } else if (viewMode.mode === "add") {
      if (key.escape) {
        setViewMode({ mode: "list" });
        return;
      }

      if (key.return) {
        if (viewMode.input.trim()) {
          saveApiKey(viewMode.provider, viewMode.input.trim());
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (viewMode.cursor > 0) {
          setViewMode({
            ...viewMode,
            input: viewMode.input.slice(0, viewMode.cursor - 1) + viewMode.input.slice(viewMode.cursor),
            cursor: viewMode.cursor - 1,
          });
        }
        return;
      }

      if (key.leftArrow) {
        setViewMode({ ...viewMode, cursor: Math.max(0, viewMode.cursor - 1) });
        return;
      }

      if (key.rightArrow) {
        setViewMode({ ...viewMode, cursor: Math.min(viewMode.input.length, viewMode.cursor + 1) });
        return;
      }

      // Regular character input (paste is handled by useBracketedPaste)
      if (input && !key.ctrl && !key.meta) {
        // Skip if pasting or if this looks like paste data
        if (isPastingRef.current || input.includes("[200~") || input.includes("[201~")) {
          return;
        }
        // Filter control characters and strip any paste markers that slipped through
        const clean = stripPasteMarkers(input.replace(/[\x00-\x1f\x7f]/g, ""));
        if (clean) {
          setViewMode({
            ...viewMode,
            input: viewMode.input.slice(0, viewMode.cursor) + clean + viewMode.input.slice(viewMode.cursor),
            cursor: viewMode.cursor + clean.length,
          });
        }
      }
    } else if (viewMode.mode === "confirm_delete") {
      if (key.escape || input.toLowerCase() === "n") {
        setViewMode({ mode: "list" });
        return;
      }

      if (input.toLowerCase() === "y") {
        deleteApiKey(viewMode.provider);
        return;
      }
    } else if (viewMode.mode === "error") {
      if (key.escape || key.return) {
        onClose();
      }
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan">Loading providers...</Text>
      </Box>
    );
  }

  if (viewMode.mode === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{viewMode.message}</Text>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    );
  }

  if (viewMode.mode === "add") {
    const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === viewMode.provider)?.name ?? viewMode.provider;

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          Set API key for {providerName}
        </Text>
        <Text> </Text>
        <Box>
          <Text color="cyan">▸ </Text>
          <Text>{stripPasteMarkers(viewMode.input)}</Text>
          <Text backgroundColor="cyan"> </Text>
        </Box>
        <Text> </Text>
        <Text dimColor>[Enter] Save  [Esc] Back to list</Text>
      </Box>
    );
  }

  if (viewMode.mode === "confirm_delete") {
    const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === viewMode.provider)?.name ?? viewMode.provider;
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Remove API key for {providerName}?
        </Text>
        <Text> </Text>
        <Text dimColor>[Y] Yes  [N/Esc] Back to list</Text>
      </Box>
    );
  }

  if (viewMode.mode === "testing") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">Testing {viewMode.provider} API key...</Text>
      </Box>
    );
  }

  // List view
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        Provider Configuration
      </Text>
      <Text>{"─".repeat(Math.min(40, width - 4))}</Text>
      <Text> </Text>

      {SUPPORTED_PROVIDERS.map((provider, index) => {
        const info = providers.find((p) => p.provider === provider.id);
        const configured = info?.configured ?? false;
        const isSelected = index === selectedIndex;
        const prefix = isSelected ? "> " : "  ";
        const status = configured ? "✓" : "○";
        const statusColor = configured ? "green" : "gray";
        const dashboardUrl = getProviderDashboardUrl(provider.id);

        return (
          <Box key={provider.id} flexDirection="column">
            <Text>
              {prefix}
              <Text color={statusColor}>{status}</Text>
              {" "}
              <Text color={isSelected ? "cyan" : undefined}>{provider.name}</Text>
            </Text>
            {isSelected && dashboardUrl && (
              <Text dimColor>    ↳ <Text color="blue">{dashboardUrl}</Text> Hold [L]</Text>
            )}
          </Box>
        );
      })}

      <Text> </Text>
      <Text>{"─".repeat(Math.min(40, width - 4))}</Text>

      {message && (
        <>
          <Text color={message.type === "success" ? "green" : "red"}>{message.text}</Text>
          <Text> </Text>
        </>
      )}

      <Text dimColor>
        [Enter/A] Add  [D] Delete  [T] Test  Hold [L] Dashboard  [R] Refresh  [Esc] Close
      </Text>
    </Box>
  );
}
