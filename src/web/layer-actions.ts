/** Stack restrictions describe the existing UI contract; they do not change layer roles. */
export function layerActionRestrictions(index: number, count: number, unavailable: boolean) {
    if (index === 0) return {
        raise: 'The primary sequence stays at the bottom; only overlays can be raised.',
        lower: 'The primary sequence stays at the bottom; only overlays can be lowered.',
        remove: 'The primary sequence cannot be deleted. Delete its excerpts instead.',
    };
    const busy = unavailable ? 'Finish or cancel the active edit, or wait until the project preview is ready.' : null;
    return {
        raise: index === count - 1 ? 'This overlay is already the top layer.' : busy,
        lower: index === 1 ? 'This overlay is already directly above the primary sequence and cannot move below it.' : busy,
        remove: busy,
    };
}
