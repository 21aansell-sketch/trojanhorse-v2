import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, i18n } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";
import React from "react";

type Message = any;

const edits = new Map<string, Message>();

let isEditing = false;
let patches: (() => void)[] = [];

function getModules() {
    return {
        LazyActionSheet: findByProps("openLazy", "hideActionSheet"),
        Messages: findByProps(
            "sendMessage",
            "startEditMessage",
            "editMessage",
            "endEditMessage",
        ),
        MessageStore: findByStoreName("MessageStore"),
        UserStore: findByStoreName("UserStore"),
        ActionSheetRow:
            findByProps("ActionSheetRow")?.ActionSheetRow ??
            Forms?.FormRow,
    };
}

function getMessage(
    MessageStore: any,
    channelId: string,
    messageId: string,
    fallback?: Message,
) {
    try {
        return (
            MessageStore?.getMessage?.(channelId, messageId) ??
            fallback
        );
    } catch {
        return fallback;
    }
}

function isActionSheetRow(
    node: any,
    ActionSheetRow: any,
): boolean {
    if (!node) return false;

    const type = node?.type;

    if (type === ActionSheetRow) return true;

    const name =
        type?.displayName ??
        type?.name ??
        type?.render?.displayName ??
        type?.render?.name;

    return name === "ActionSheetRow" || name === "FormRow";
}

function findActionSheetButtons(
    tree: any,
    ActionSheetRow: any,
): any[] | undefined {
    try {
        const result = findInReactTree(
            tree,
            (node: any) => {
                if (!Array.isArray(node)) return false;

                return node.some(
                    (child: any) =>
                        child?.props &&
                        isActionSheetRow(child, ActionSheetRow),
                );
            },
        );

        return Array.isArray(result) ? result : undefined;
    } catch {
        return undefined;
    }
}

function cloneMessage(message: Message): Message {
    try {
        return JSON.parse(JSON.stringify(message));
    } catch {
        return { ...message };
    }
}

export default {
    onLoad() {
        // Resolve Discord/Vendetta modules only when the plugin is enabled.
        // If a module is unavailable on this client version, fail closed
        // instead of throwing and causing the plugin to be disabled.
        let modules: ReturnType<typeof getModules>;

        try {
            modules = getModules();
        } catch (error) {
            console.error("[LocalEdit] Failed to resolve modules:", error);
            return;
        }

        const {
            LazyActionSheet,
            Messages,
            MessageStore,
            UserStore,
            ActionSheetRow,
        } = modules;

        if (!LazyActionSheet?.openLazy) {
            console.error("[LocalEdit] Message action sheet API unavailable.");
            return;
        }

        if (!Messages?.editMessage || !Messages?.startEditMessage) {
            console.error("[LocalEdit] Message edit API unavailable.");
            return;
        }

        if (!ActionSheetRow) {
            console.error("[LocalEdit] ActionSheetRow unavailable.");
            return;
        }

        try {
            patches.push(
                before(
                    "openLazy",
                    LazyActionSheet,
                    ([component, key, msg]) => {
                        if (key !== "MessageLongPressActionSheet") {
                            return;
                        }

                        const message = msg?.message;

                        if (!message?.id || !message?.channel_id) {
                            return;
                        }

                        // openLazy normally receives a promise for the sheet.
                        Promise.resolve(component)
                            .then((instance: any) => {
                                if (!instance?.default) return;

                                let sheetPatch: (() => void) | undefined;

                                try {
                                    sheetPatch = after(
                                        "default",
                                        instance,
                                        (_args: any, res: any) => {
                                            setTimeout(() => {
                                                try {
                                                    const buttons =
                                                        findActionSheetButtons(
                                                            res,
                                                            ActionSheetRow,
                                                        );

                                                    if (!buttons) return;

                                                    const currentMessage =
                                                        getMessage(
                                                            MessageStore,
                                                            message.channel_id,
                                                            message.id,
                                                            message,
                                                        );

                                                    if (!currentMessage) return;

                                                    const currentUser =
                                                        UserStore?.getCurrentUser?.();

                                                    // Preserve the original behavior:
                                                    // do not add the local-edit action
                                                    // to messages belonging to the
                                                    // current user.
                                                    if (
                                                        currentUser?.id &&
                                                        currentMessage.author?.id ===
                                                            currentUser.id
                                                    ) {
                                                        return;
                                                    }

                                                    if (
                                                        buttons.some(
                                                            (button: any) =>
                                                                button?.props
                                                                    ?.label ===
                                                                "Edit Locally",
                                                        )
                                                    ) {
                                                        return;
                                                    }

                                                    const markUnreadIndex =
                                                        buttons.findIndex(
                                                            (button: any) =>
                                                                button?.props
                                                                    ?.message ===
                                                                i18n?.Messages
                                                                    ?.MARK_UNREAD,
                                                        );

                                                    const position =
                                                        markUnreadIndex >= 0
                                                            ? markUnreadIndex
                                                            : Math.max(
                                                                  buttons.length -
                                                                      1,
                                                                  0,
                                                              );

                                                    const handleEdit = () => {
                                                        try {
                                                            isEditing = true;

                                                            if (
                                                                !edits.has(
                                                                    currentMessage.id,
                                                                )
                                                            ) {
                                                                edits.set(
                                                                    currentMessage.id,
                                                                    cloneMessage(
                                                                        currentMessage,
                                                                    ),
                                                                );
                                                            }

                                                            LazyActionSheet?.hideActionSheet?.();

                                                            Messages.startEditMessage(
                                                                currentMessage.channel_id,
                                                                currentMessage.id,
                                                                currentMessage.content ??
                                                                    "",
                                                            );
                                                        } catch (error) {
                                                            isEditing = false;
                                                            console.error(
                                                                "[LocalEdit] Failed to start local edit:",
                                                                error,
                                                            );
                                                        }
                                                    };

                                                    const Icon = (
                                                        ActionSheetRow as any
                                                    )?.Icon;

                                                    const icon = Icon
                                                        ? React.createElement(
                                                              Icon,
                                                              {
                                                                  source: getAssetIDByName(
                                                                      "ic_edit_24px",
                                                                  ),
                                                              },
                                                          )
                                                        : undefined;

                                                    const button =
                                                        React.createElement(
                                                            ActionSheetRow,
                                                            {
                                                                label: "Edit Locally",
                                                                icon,
                                                                onPress:
                                                                    handleEdit,
                                                            },
                                                        );

                                                    buttons.splice(
                                                        position,
                                                        0,
                                                        button,
                                                    );
                                                } catch (error) {
                                                    console.error(
                                                        "[LocalEdit] Failed to add Edit Locally:",
                                                        error,
                                                    );
                                                } finally {
                                                    try {
                                                        sheetPatch?.();
                                                    } catch {
                                                        // Already unpatched.
                                                    }
                                                }
                                            }, 0);
                                        },
                                    );
                                } catch (error) {
                                    console.error(
                                        "[LocalEdit] Failed to patch action sheet:",
                                        error,
                                    );
                                }
                            })
                            .catch((error: any) => {
                                console.error(
                                    "[LocalEdit] Failed to load action sheet:",
                                    error,
                                );
                            });
                    },
                ),
            );
        } catch (error) {
            console.error(
                "[LocalEdit] Failed to patch openLazy:",
                error,
            );
        }

        try {
            patches.push(
                before(
                    "editMessage",
                    Messages,
                    (args: any[]) => {
                        if (!isEditing) return;

                        const [, messageId, message] = args;
                        const baseMessage = edits.get(messageId);

                        if (!baseMessage) {
                            isEditing = false;
                            return;
                        }

                        try {
                            const newContent =
                                typeof message === "string"
                                    ? message
                                    : message?.content ?? "";

                            FluxDispatcher.dispatch({
                                type: "MESSAGE_UPDATE",
                                message: {
                                    ...baseMessage,
                                    content: newContent,
                                    edited_timestamp: null,
                                },
                                otherPluginBypass: true,
                            });

                            return false;
                        } catch (error) {
                            isEditing = false;
                            console.error(
                                "[LocalEdit] Failed to apply local edit:",
                                error,
                            );
                        }
                    },
                ),
            );
        } catch (error) {
            console.error(
                "[LocalEdit] Failed to patch editMessage:",
                error,
            );
        }

        if (Messages?.endEditMessage) {
            try {
                patches.push(
                    after(
                        "endEditMessage",
                        Messages,
                        () => {
                            isEditing = false;
                        },
                    ),
                );
            } catch (error) {
                console.error(
                    "[LocalEdit] Failed to patch endEditMessage:",
                    error,
                );
            }
        }
    },

    onUnload() {
        for (const unpatch of patches) {
            try {
                unpatch();
            } catch {
                // Ignore already removed patches.
            }
        }

        patches = [];
        edits.clear();
        isEditing = false;
    },
};
