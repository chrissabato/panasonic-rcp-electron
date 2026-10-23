// Protocol-agnostic boolean toggle widget (AWB/auto-iris/tally style switches).
export function createToggle({ value = false, onChange } = {}) {
    const el = document.createElement('div');
    el.className = 'toggle-switch';
    el.setAttribute('role', 'switch');
    el.tabIndex = 0;

    let current = !!value;

    function render() {
        el.classList.toggle('on', current);
        el.setAttribute('aria-checked', String(current));
    }

    function toggle() {
        current = !current;
        render();
        onChange?.(current, { final: true });
    }

    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
        }
    });

    render();

    return {
        el,
        setValue: (v) => {
            current = !!v;
            render();
        },
        getValue: () => current,
    };
}
