import { Buffer } from "buffer";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GripVertical,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { ProjectIconView } from "@/components/project-icon-view";
import { ProjectLeadingVisual } from "@/components/sidebar/project-leading-visual";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarProjectStatusBucket } from "@/hooks/use-sidebar-workspaces-list";
import {
  useSidebarProjectGroupsStore,
  type SidebarProjectGroup,
} from "@/stores/sidebar-project-groups-store";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const editGroupLeading = <ThemedPencil size={14} uniProps={mutedMapping} />;
const deleteGroupLeading = <ThemedTrash2 size={14} uniProps={mutedMapping} />;
const headerButtonStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.headerButton,
  pressed && styles.pressed,
];
const groupMainStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.groupMain,
  pressed && styles.pressed,
];

export function NewProjectGroupButton(): ReactElement {
  const openEditor = useSidebarProjectGroupsStore((state) => state.openEditor);
  const open = useCallback(() => openEditor("new"), [openEditor]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New project group"
      hitSlop={8}
      onPress={open}
      style={headerButtonStyle}
      testID="sidebar-new-project-group"
    >
      <ThemedFolderPlus size={15} uniProps={mutedMapping} />
    </Pressable>
  );
}

function ProjectGroupDragHandle({
  id,
  name,
  drag,
  dragHandleProps,
}: {
  id: string;
  name: string;
  drag?: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
}): ReactElement | null {
  if (!drag) return null;
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};
  return (
    <View
      {...dragAttributes}
      {...dragHandleProps?.listeners}
      ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Reorder ${name}`}
        delayLongPress={200}
        hitSlop={6}
        onLongPress={drag}
        style={styles.groupDragHandle}
        testID={`sidebar-project-group-drag-${id}`}
      >
        <ThemedGripVertical size={14} uniProps={mutedMapping} />
      </Pressable>
    </View>
  );
}

export function ProjectGroupBlock({
  group,
  projects,
  children,
  drag,
  dragHandleProps,
  isDragging = false,
}: {
  group: SidebarProjectGroup | null;
  projects: readonly SidebarProjectEntry[];
  children: ReactElement | ReactElement[] | null;
  drag?: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
  isDragging?: boolean;
}): ReactElement | null {
  const collapsedIds = useSidebarProjectGroupsStore((state) => state.collapsedGroupIds);
  const toggle = useSidebarProjectGroupsStore((state) => state.toggleGroupCollapsed);
  const openEditor = useSidebarProjectGroupsStore((state) => state.openEditor);
  const deleteGroup = useSidebarProjectGroupsStore((state) => state.deleteGroup);
  const syntheticId = "__ungrouped__";
  const id = group?.id ?? syntheticId;
  const collapsed = collapsedIds.has(id);
  const workspaces = useMemo(() => projects.flatMap((project) => project.workspaces), [projects]);
  const statusBucket = useSidebarProjectStatusBucket({ workspaces, enabled: collapsed });
  const name = group?.name ?? "Ungrouped";
  const handleToggle = useCallback(() => toggle(id), [id, toggle]);
  const handleEdit = useCallback(() => group && openEditor(group.id), [group, openEditor]);
  const handleDelete = useCallback(() => {
    if (!group) return;
    void confirmDialog({
      title: "Delete project group?",
      message: `Projects in “${group.name}” will move to Ungrouped.`,
      confirmLabel: "Delete group",
      cancelLabel: "Cancel",
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) deleteGroup(group.id);
      return undefined;
    });
  }, [deleteGroup, group]);

  if (!group && projects.length === 0) return null;

  return (
    <View
      role="group"
      accessibilityLabel={name}
      style={[styles.groupBlock, isDragging && styles.groupBlockDragging]}
    >
      <View style={styles.groupRow}>
        {group ? (
          <ProjectGroupDragHandle
            id={id}
            name={name}
            drag={drag}
            dragHandleProps={dragHandleProps}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${name}`}
          onPress={handleToggle}
          style={groupMainStyle}
          testID={`sidebar-project-group-${id}`}
        >
          <ProjectLeadingVisual
            displayName={name}
            iconDataUri={group?.iconUri ?? null}
            statusBucket={statusBucket}
            projectViewKey={`project-group:${id}`}
            backdrop="surfaceSidebar"
          />
          {collapsed ? (
            <ThemedChevronRight size={14} uniProps={mutedMapping} />
          ) : (
            <ThemedChevronDown size={14} uniProps={mutedMapping} />
          )}
          <Text style={styles.groupName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.groupCount}>{projects.length}</Text>
        </Pressable>
        {group ? (
          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              accessibilityRole="button"
              accessibilityLabel={`${name} actions`}
              hitSlop={8}
              style={styles.groupMenuTrigger}
              testID={`sidebar-project-group-menu-${id}`}
            >
              {({ hovered }) => (
                <ThemedMoreVertical
                  size={14}
                  uniProps={hovered ? foregroundMapping : mutedMapping}
                />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width={210} sheetTitle={`${name} actions`}>
              <DropdownMenuItem leading={editGroupLeading} onSelect={handleEdit}>
                Edit group
              </DropdownMenuItem>
              <DropdownMenuItem leading={deleteGroupLeading} onSelect={handleDelete}>
                Delete group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </View>
      {collapsed ? null : <View style={styles.groupChildren}>{children}</View>}
    </View>
  );
}

export function SidebarProjectGroupModals(): ReactElement {
  const editorTarget = useSidebarProjectGroupsStore((state) => state.editorTarget);
  const assignmentProjectViewKey = useSidebarProjectGroupsStore(
    (state) => state.assignmentProjectViewKey,
  );
  const groups = useSidebarProjectGroupsStore((state) => state.groups);
  const assignments = useSidebarProjectGroupsStore((state) => state.groupIdByProjectViewKey);
  const closeEditor = useSidebarProjectGroupsStore((state) => state.closeEditor);
  const closeAssignment = useSidebarProjectGroupsStore((state) => state.closeAssignment);
  const createGroup = useSidebarProjectGroupsStore((state) => state.createGroup);
  const updateGroup = useSidebarProjectGroupsStore((state) => state.updateGroup);
  const assignProject = useSidebarProjectGroupsStore((state) => state.assignProject);
  const editing =
    editorTarget && editorTarget !== "new"
      ? (groups.find(({ id }) => id === editorTarget) ?? null)
      : null;
  const [name, setName] = useState("");
  const [iconUri, setIconUri] = useState("");
  const isCompact = useIsCompactFormFactor();
  const { pickFiles } = useFilePicker();
  const toast = useToast();

  useEffect(() => {
    setName(editing?.name ?? "");
    setIconUri(editing?.iconUri ?? "");
  }, [editing, editorTarget]);

  const chooseImage = useCallback(() => {
    void pickFiles().then((files) => {
      const file = files?.[0];
      if (!file) return undefined;
      if (file.bytes.byteLength > 512 * 1024) {
        toast.error("Group icons must be 512 KB or smaller");
        return undefined;
      }
      const mimeType = file.mimeType?.startsWith("image/") ? file.mimeType : "image/png";
      setIconUri(`data:${mimeType};base64,${Buffer.from(file.bytes).toString("base64")}`);
      return undefined;
    });
  }, [pickFiles, toast]);
  const clearImage = useCallback(() => setIconUri(""), []);

  const save = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed || !editorTarget) return;
    if (editorTarget === "new") createGroup({ name: trimmed, iconUri });
    else updateGroup(editorTarget, { name: trimmed, iconUri });
    closeEditor();
  }, [closeEditor, createGroup, editorTarget, iconUri, name, updateGroup]);

  const editorHeader = useMemo(
    () => ({ title: editorTarget === "new" ? "New project group" : "Edit project group" }),
    [editorTarget],
  );
  const assignmentHeader = useMemo(() => ({ title: "Move project to group" }), []);
  const editorFooter = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="outline" size="md" onPress={closeEditor}>
          Cancel
        </Button>
        <Button size="md" disabled={!name.trim()} onPress={save}>
          Save
        </Button>
      </View>
    ),
    [closeEditor, name, save],
  );

  const chooseGroup = useCallback(
    (groupId: string | null) => {
      if (!assignmentProjectViewKey) return;
      assignProject(assignmentProjectViewKey, groupId);
      closeAssignment();
    },
    [assignProject, assignmentProjectViewKey, closeAssignment],
  );

  return (
    <>
      <AdaptiveModalSheet
        visible={editorTarget !== null}
        onClose={closeEditor}
        header={editorHeader}
        footer={editorFooter}
        sizeContentToCurrentSnapPoint
        testID="sidebar-project-group-editor"
      >
        <View style={styles.editorFields}>
          <View style={styles.previewRow}>
            <ProjectIconView
              iconDataUri={iconUri.trim() || null}
              initial={Array.from(name.trim())[0]?.toUpperCase() || "?"}
              projectViewKey={`project-group:${editing?.id ?? name}`}
              size={36}
              textStyle={styles.previewText}
            />
            <Button variant="outline" size={isCompact ? "md" : "sm"} onPress={chooseImage}>
              Choose image
            </Button>
            {iconUri ? (
              <Button variant="ghost" size={isCompact ? "md" : "sm"} onPress={clearImage}>
                Use initial
              </Button>
            ) : null}
          </View>
          <Text style={styles.previewHint}>Leave the icon blank to use the first letter.</Text>
          <Field label="Name">
            <FormTextInput
              size={isCompact ? "md" : "sm"}
              initialValue={editing?.name ?? ""}
              resetKey={`${editorTarget}:name`}
              onChangeText={setName}
              onSubmitEditing={save}
              accessibilityLabel="Project group name"
              testID="sidebar-project-group-name"
            />
          </Field>
          <Field label="Icon URL (optional)">
            <FormTextInput
              size={isCompact ? "md" : "sm"}
              initialValue={editing?.iconUri ?? ""}
              resetKey={`${editorTarget}:icon`}
              onChangeText={setIconUri}
              onSubmitEditing={save}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Project group icon URL"
              testID="sidebar-project-group-icon"
            />
          </Field>
        </View>
      </AdaptiveModalSheet>

      <AdaptiveModalSheet
        visible={assignmentProjectViewKey !== null}
        onClose={closeAssignment}
        header={assignmentHeader}
        sizeContentToCurrentSnapPoint
        testID="sidebar-project-group-assignment"
      >
        <View style={styles.assignmentList}>
          {groups.map((group) => (
            <ProjectGroupChoice
              key={group.id}
              group={group}
              selected={assignments[assignmentProjectViewKey ?? ""] === group.id}
              onChoose={chooseGroup}
            />
          ))}
          <ProjectGroupChoice
            group={null}
            selected={!assignments[assignmentProjectViewKey ?? ""]}
            onChoose={chooseGroup}
          />
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

function ProjectGroupChoice({
  group,
  selected,
  onChoose,
}: {
  group: SidebarProjectGroup | null;
  selected: boolean;
  onChoose: (groupId: string | null) => void;
}): ReactElement {
  const name = group?.name ?? "Ungrouped";
  const groupId = group?.id ?? null;
  const onPress = useCallback(() => onChoose(groupId), [groupId, onChoose]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.choice,
      selected && styles.choiceSelected,
      pressed && styles.pressed,
    ],
    [selected],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={pressableStyle}
    >
      <ProjectIconView
        iconDataUri={group?.iconUri ?? null}
        initial={Array.from(name)[0]?.toUpperCase() || "?"}
        projectViewKey={`project-group:${group?.id ?? "ungrouped"}`}
        size={24}
        textStyle={styles.choiceIconText}
      />
      <Text style={styles.choiceText}>{name}</Text>
      {selected ? <Text style={styles.selectedMark}>✓</Text> : null}
    </Pressable>
  );
}

export function useOpenProjectGroupAssignment(): (projectViewKey: string) => void {
  return useSidebarProjectGroupsStore((state) => state.openAssignment);
}

const styles = StyleSheet.create((theme) => ({
  headerButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
  },
  pressed: { opacity: 0.65 },
  groupBlock: { marginBottom: theme.spacing[1] },
  groupBlockDragging: { opacity: 0.7 },
  groupRow: {
    minHeight: 34,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
  },
  groupDragHandle: {
    width: 22,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  groupMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  groupName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  groupCount: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  groupMenuTrigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
  },
  groupChildren: { paddingLeft: theme.spacing[2] },
  footer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  editorFields: { gap: theme.spacing[4] },
  previewRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  previewText: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.bold },
  previewHint: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  assignmentList: { gap: theme.spacing[1] },
  choice: {
    minHeight: 40,
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  choiceSelected: { backgroundColor: theme.colors.surface2 },
  choiceIconText: { fontSize: 9, fontWeight: theme.fontWeight.bold },
  choiceText: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  selectedMark: { color: theme.colors.accent, fontSize: theme.fontSize.base },
}));
