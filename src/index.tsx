from pathlib import Path

code = r'''import React from "react";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, i18n } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

type Message = any;

const edits = new Map<string, Message>();

let isEditing = false;
let patches: (() => void)[] = [];

/**
 * Resolve Vendetta/Discord modules lazily.
 *
 * Keeping these lookups inside onLoad prevents a missing/changed Metro export
 * from making the plugin fail while the plugin module itself is loading.
 */
function getModules() {
    const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
    const Messages = findByProps(
        "sendMessage",
        "startEditMessage",
        "editMessage",
        "endEditMessage",
    );
    const MessageStore = findByStoreName("MessageStore");
    const UserStore = findByStoreName("UserStore");

    const ActionSheetRow =
        findByProps("ActionSheetRow")?.ActionSheetRow ??
        Forms?.FormRow;

    return {
        LazyActionSheet,
        Messages,
        MessageStore,
        UserStore,
        ActionSheetRow,
    };
}

function getMessage(
    MessageStore: any,
    channelId: string,
    messageId: string,
    fallback?: Message,
): Message | undefined {
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
    if (!tree) return undefined;

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

function cloneMessage(message: Message): Message | undefined {
    try {
        return JSON.parse(JSON.stringify(message));
    } catch {
        return undefined;
    }
}

function safeUnpatch(unpatch: (() => void) | undefined) {
    if (typeof unpatch !== "function") return;

    try {
        unpatch();
    } catch {
        // Ignore already-removed patches.
    }
}

export default {
    onLoad() {
        // Avoid duplicate patches if the host calls onLoad more than once.
        if (patches.length > 0) return;

        const {
            LazyActionSheet,
            Messages,
            MessageStore,
            UserStore,
            ActionSheetRow,
        } = getModules();

        /*
         * Without these modules there is nothing useful to patch.
         * Failing closed is preferable to preventing the plugin from loading.
         */
        if (!LazyActionSheet?.openLazy || !ActionSheetRow) {
            console.warn(
                "[LocalEdit] Required action-sheet modules were not found.",
            );
        } else {
            const unpatchOpenLazy = before(
                "openLazy",
                LazyActionSheet,
                ([component, key, msg]: any[]) => {
                    if (key !== "MessageLongPressActionSheet") return;

                    const message = msg?.message;
                    if (!message?.id || !message?.channel_id) return;

                    /*
                     * Discord/Vendetta may return a Promise here. Do not assume
                     * it is a Promise, and do not let a rejection escape.
                     */
                    let componentPromise: Promise<any>;

                    try {
                        componentPromise = Promise.resolve(component);
                    } catch {
                        return;
                    }

                    void componentPromise.then(
                        (instance: any) => {
                            if (!instance) return;

                            let unpatchComponent: (() => void) | undefined;

                            try {
                                unpatchComponent = after(
                                    "default",
                                    instance,
                                    (_args: any, res: any) => {
                                        /*
                                         * The action sheet is still being
                                         * rendered when this hook fires, so
                                         * defer mutation until the current
                                         * render has completed.
                                         */
                                        setTimeout(() => {
                                            try {
                                                const buttons =
                                                    findActionSheetButtons(
                                                        res,
                                                        ActionSheetRow,
                                                    );

                                                if (!buttons) return;

                                                const currentUser =
                                                    UserStore?.getCurrentUser?.();

                                                const currentMessage =
                                                    getMessage(
                                                        MessageStore,
                                                        message.channel_id,
                                                        message.id,
                                                        message,
                                                    );

                                                if (!currentMessage) return;

                                                // Preserve the original behavior:
                                                // only add "Edit Locally" to messages
                                                // not authored by the current user.
                                                if (
                                                    currentUser?.id &&
                                                    currentMessage.author?.id ===
                                                        currentUser.id
                                                ) {
                                                    return;
                                                }

                                                // Prevent duplicate rows.
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
                                                            i18n.Messages
                                                                .MARK_UNREAD,
                                                    );

                                                const position =
                                                    markUnreadIndex >= 0
                                                        ? markUnreadIndex
                                                        : Math.max(
                                                              buttons.length - 1,
                                                              0,
                                                          );

                                                const handleEdit = () => {
                                                    const snapshot =
                                                        cloneMessage(
                                                            currentMessage,
                                                        );

                                                    if (!snapshot) {
                                                        console.warn(
                                                            "[LocalEdit] Could not snapshot message.",
                                                        );
                                                        return;
                                                    }

                                                    /*
                                                     * Store the original message
                                                     * before opening Discord's edit
                                                     * composer. This is what lets
                                                     * editMessage replace the
                                                     * remote edit with a local
                                                     * MESSAGE_UPDATE.
                                                     */
                                                    isEditing = true;

                                                    if (
                                                        !edits.has(
                                                            currentMessage.id,
                                                        )
                                                    ) {
                                                        edits.set(
                                                            currentMessage.id,
                                                            snapshot,
                                                        );
                                                    }

                                                    try {
                                                        LazyActionSheet.hideActionSheet?.();
                                                    } catch {
                                                        // The composer can still
                                                        // be opened if this fails.
                                                    }

                                                    try {
                                                        Messages?.startEditMessage?.(
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

                                                /*
                                                 * Some Discord/Vendetta builds
                                                 * expose ActionSheetRow.Icon while
                                                 * others only expose the row
                                                 * component. Only render the icon
                                                 * when that property exists.
                                                 */
                                                const RowIcon =
                                                    ActionSheetRow?.Icon;

                                                const button = (
                                                    <ActionSheetRow
                                                        label="Edit Locally"
                                                        {...(RowIcon
                                                            ? {
                                                                  icon: (
                                                                      <RowIcon
                                                                          source={getAssetIDByName(
                                                                              "ic_edit_24px",
                                                                          )}
                                                                      />
                                                                  ),
                                                              }
                                                            : {})}
                                                        onPress={handleEdit}
                                                    />
                                                );

                                                buttons.splice(
                                                    position,
                                                    0,
                                                    button,
                                                );
                                            } catch (error) {
                                                console.error(
                                                    "[LocalEdit] Failed to patch action sheet:",
                                                    error,
                                                );
                                            } finally {
                                                safeUnpatch(
                                                    unpatchComponent,
                                                );
                                            }
                                        }, 0);
                                    },
                                );
                            } catch (error) {
                                console.error(
                                    "[LocalEdit] Failed to patch action-sheet component:",
                                    error,
                                );
                            }
                        },
                        (error: any) => {
                            console.error(
                                "[LocalEdit] Failed to resolve action-sheet component:",
                                error,
                            );
                        },
                    );
                },
            );

            patches.push(unpatchOpenLazy);
        }

        /*
         * Intercept Discord's normal edit operation only while the local
         * composer is active. The original remote message is never sent.
         */
        if (Messages?.editMessage) {
            const unpatchEditMessage = before(
                "editMessage",
                Messages,
                (args: any[]) => {
                    if (!isEditing) return;

                    const [channelId, messageId, message] = args;
                    const baseMessage = edits.get(messageId);

                    /*
                     * Fail closed if the message snapshot is unavailable.
                     * This prevents an unrelated edit from being swallowed.
                     */
                    if (!baseMessage) {
                        isEditing = false;
                        return;
                    }

                    const newContent =
                        typeof message === "string"
                            ? message
                            : message?.content ?? "";

                    try {
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: {
                                ...baseMessage,
                                channel_id:
                                    baseMessage.channel_id ?? channelId,
                                id: baseMessage.id ?? messageId,
                                content: newContent,
                                edited_timestamp: null,
                            },
                            otherPluginBypass: true,
                        });

                        /*
                         * Preserve the original functionality: returning false
                         * prevents Discord's normal edit operation from being
                         * sent remotely.
                         */
                        return false;
                    } catch (error) {
                        /*
                         * If the local dispatch itself fails, allow the normal
                         * edit path to continue rather than silently swallowing
                         * the user's edit.
                         */
                        isEditing = false;
                        console.error(
                            "[LocalEdit] Failed to dispatch local message update:",
                            error,
                        );
                    }
                },
            );

            patches.push(unpatchEditMessage);
        }

        /*
         * Discord calls endEditMessage when the edit composer closes.
         * Resetting here prevents the next ordinary edit from being treated
         * as a local edit.
         */
        if (Messages?.endEditMessage) {
            const unpatchEndEditMessage = after(
                "endEditMessage",
                Messages,
                () => {
                    isEditing = false;
                },
            );

            patches.push(unpatchEndEditMessage);
        }
    },

    onUnload() {
        for (const unpatch of patches) {
            safeUnpatch(unpatch);
        }

        patches = [];
        edits.clear();
        isEditing = false;
    },
};
'''

path = Path("/mnt/data/index.corrected.tsx")
path.write_text(code, encoding="utf-8")
print(f"Created {path} ({len(code.splitlines())} lines).")
