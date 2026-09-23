import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { Theme } from "@/styles/theme";

export interface CommitMessageModalProps {
  visible: boolean;
  /** Staged-only commits must carry a message; "commit all" may defer to Paseo's generator. */
  requireMessage: boolean;
  onClose: () => void;
  onSubmit: (message: string) => Promise<void> | void;
}

export function CommitMessageModal({
  visible,
  requireMessage,
  onClose,
  onSubmit,
}: CommitMessageModalProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft("");
    setError(null);
    setIsPending(false);
    const timeout = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timeout);
  }, [visible]);

  const handleChange = useCallback((value: string) => {
    setDraft(value);
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (isPending) return;
    const message = draft.trim();
    if (requireMessage && !message) {
      setError("Enter a commit message for staged changes.");
      return;
    }
    try {
      setIsPending(true);
      await onSubmit(message);
      setIsPending(false);
      onClose();
    } catch (err) {
      setIsPending(false);
      setError(err instanceof Error && err.message ? err.message : "Unable to commit.");
    }
  }, [draft, isPending, onClose, onSubmit, requireMessage]);

  const handleSubmitVoid = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    onClose();
  }, [isPending, onClose]);

  const sheetHeader = useMemo<SheetHeader>(
    () => ({ title: requireMessage ? "Commit staged changes" : "Commit all changes" }),
    [requireMessage],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleCancel}
      header={sheetHeader}
      testID="commit-message-modal"
    >
      <View style={styles.body}>
        <AdaptiveTextInput
          ref={inputRef}
          initialValue=""
          onChangeText={handleChange}
          placeholder={
            requireMessage ? "Commit message" : "Commit message (blank lets Paseo generate one)"
          }
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          onSubmitEditing={handleSubmitVoid}
          style={styles.input}
          testID="commit-message-modal-input"
        />
        {error ? (
          <Text style={styles.error} testID="commit-message-modal-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            onPress={handleCancel}
            disabled={isPending}
            testID="commit-message-modal-cancel"
          >
            Cancel
          </Button>
          <Button
            onPress={handleSubmitVoid}
            disabled={isPending || (requireMessage && !draft.trim())}
            testID="commit-message-modal-submit"
          >
            Commit
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  input: {
    width: "100%",
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    justifyContent: "flex-end",
  },
}));
