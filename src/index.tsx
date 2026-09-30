import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

type Message = any;
type Unpatch = () => void;

const edits = new Map<string, Message>();
let isEditing = false;
let loaded = false;
const patches: Unpatch[] = [];

function getModules() {
    try {
        const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
        const Messages = findByProps(
            "startEditMessage",
            "editMessage",
            "endEditMessage",
        );
        const MessageStore = findByStoreName("MessageStore");
        const UserStore = findByStoreName("UserStore");
        const ActionSheetRow =
            findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms?.FormRow;

        return { LazyActionSheet, Messages, MessageStore, UserStore, ActionSheetRow };
    } catch (error) {
        console.error("[TrojanHorse] Failed to resolve Discord modules", error);
        return null;
    }
}

function safePatch(patch: (() => void) | undefined | null) {
    if (typeof patch === "function") patches.push(patch);
}

function safeClone<T>(value: T): T {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

function getMessage(MessageStore: any, channelId: string, messageId: string, fallback?: Message) {
    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? fallback;
    } catch {
        return fallback;
    }
}

function getComponentName(type: any) {
    return (
        type?.displayName ??
        type?.name ??
        type?.render?.displayName ??
        type?.render?.name
    );
}

function isActionSheetRow(node: any, ActionSheetRow: any) {
    if (!node) return false;
    const type = node.type;
    return (
        type === ActionSheetRow ||
        getComponentName(type) === "ActionSheetRow" ||
        getComponentName(type) === "FormRow"
    );
}

function findActionSheetButtons(tree: any, ActionSheetRow: any) {
    try {
        const result = findInReactTree(tree, (node: any) => {
            if (!Array.isArray(node)) return false;
            return node.some(
                (child: any) => child?.props && isActionSheetRow(child, ActionSheetRow),
            );
        });
        return Array.isArray(result) ? result : undefined;
    } catch (error) {
        console.error("[TrojanHorse] Failed to inspect action sheet", error);
        return undefined;
    }
}

function resetEditState() {
    isEditing = false;
}

export default {
    onLoad() {
        if (loaded) return;
        loaded = true;

        const modules = getModules();
        if (!modules) {
            loaded = false;
            return;
        }

        const {
            LazyActionSheet,
            Messages,
            MessageStore,
            UserStore,
            ActionSheetRow,
        } = modules;

        // A plugin should never stay enabled if its required host APIs are absent.
        if (!LazyActionSheet?.openLazy || !Messages?.startEditMessage || !Messages?.editMessage) {
            console.warn("[TrojanHorse] Required Discord APIs are unavailable; plugin not loaded");
            loaded = false;
            return;
        }

        safePatch(
            before("openLazy", LazyActionSheet, ([component, key, props]: any[]) => {
                if (key !== "MessageLongPressActionSheet") return;

                const originalMessage = props?.message;
                if (!originalMessage?.id || !originalMessage?.channel_id) return;

                const promise = component?.then;
                if (typeof promise !== "function") return;

                component.then((instance: any) => {
                    if (!instance?.default) return;

                    let actionSheetUnpatch: Unpatch | undefined;

                    try {
                        actionSheetUnpatch = after(
                            "default",
                            instance,
                            (_args: any[], result: any) => {
                                setTimeout(() => {
                                    try {
                                        const buttons = findActionSheetButtons(result, ActionSheetRow);
                                        if (!buttons || !ActionSheetRow) return;

                                        const currentMessage = getMessage(
                                            MessageStore,
                                            originalMessage.channel_id,
                                            originalMessage.id,
                                            originalMessage,
                                        );
                                        if (!currentMessage) return;

                                        const currentUser = UserStore?.getCurrentUser?.();
                                        if (currentUser?.id && currentMessage.author?.id !== currentUser.id) {
                                            return;
                                        }

                                        if (
                                            buttons.some(
                                                (button: any) =>
                                                    button?.props?.label === "Edit Locally",
                                            )
                                        ) {
                                            return;
                                        }

                                        const handleEdit = () => {
                                            const snapshot = safeClone(currentMessage);
                                            edits.set(currentMessage.id, snapshot);
                                            isEditing = true;

                                            try {
                                                LazyActionSheet.hideActionSheet?.();
                                                Messages.startEditMessage(
                                                    currentMessage.channel_id,
                                                    currentMessage.id,
                                                    currentMessage.content ?? "",
                                                );
                                            } catch (error) {
                                                console.error("[TrojanHorse] Failed to start local edit", error);
                                                edits.delete(currentMessage.id);
                                                resetEditState();
                                            }
                                        };

                                        const iconId = (() => {
                                            try {
                                                return getAssetIDByName("ic_edit_24px");
                                            } catch {
                                                return undefined;
                                            }
                                        })();

                                        const icon = iconId != null && (ActionSheetRow as any).Icon
                                            ? React.createElement((ActionSheetRow as any).Icon, { source: iconId })
                                            : undefined;

                                        const button = React.createElement(ActionSheetRow, {
                                            label: "Edit Locally",
                                            ...(icon ? { icon } : {}),
                                            onPress: handleEdit,
                                        });

                                        // Insert before the final destructive/secondary actions when possible.
                                        const position = Math.max(buttons.length - 1, 0);
                                        buttons.splice(position, 0, button);
                                    } catch (error) {
                                        console.error("[TrojanHorse] Failed to add Edit Locally", error);
                                    } finally {
                                        try {
                                            actionSheetUnpatch?.();
                                        } catch {}
                                        actionSheetUnpatch = undefined;
                                    }
                                }, 0);
                            },
                        );
                    } catch (error) {
                        console.error("[TrojanHorse] Failed to patch action sheet component", error);
                    }
                }).catch((error: any) => {
                    console.error("[TrojanHorse] Failed to load action sheet component", error);
                });
            }),
        );

        safePatch(
            before("editMessage", Messages, (args: any[]) => {
                if (!isEditing) return;

                const channelId = args?.[0];
                const messageId = args?.[1];
                const payload = args?.[2];
                const snapshot = messageId ? edits.get(messageId) : undefined;

                if (!snapshot) {
                    resetEditState();
                    return;
                }

                const newContent =
                    typeof payload === "string" ? payload : payload?.content ?? "";

                try {
                    FluxDispatcher.dispatch({
                        type: "MESSAGE_UPDATE",
                        message: {
                            ...snapshot,
                            channel_id: channelId ?? snapshot.channel_id,
                            id: messageId ?? snapshot.id,
                            content: newContent,
                            edited_timestamp: null,
                        },
                        otherPluginBypass: true,
                    });
                    return false;
                } catch (error) {
                    console.error("[TrojanHorse] Local edit dispatch failed", error);
                    resetEditState();
                }
            }),
        );

        if (Messages.endEditMessage) {
            safePatch(
                after("endEditMessage", Messages, () => {
                    resetEditState();
                }),
            );
        }
    },

    onUnload() {
        for (const unpatch of patches.splice(0)) {
            try {
                unpatch();
            } catch {}
        }

        edits.clear();
        resetEditState();
        loaded = false;
    },
};
