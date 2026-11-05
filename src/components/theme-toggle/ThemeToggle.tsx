import { useIsomorphicLayoutEffect } from '../../hooks/useIsomorphicLayoutEffect'
import { Listbox } from '@headlessui/react'
import React, { Fragment, useEffect, useRef, useState } from 'react'
import { Pc } from '../icons/svg/device/Icons'
import { Moon, Sun } from '../icons/svg/weather/Icons'

function update() {
    if (
        localStorage.theme === 'dark' ||
        (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ) {
        document.documentElement.classList.add('dark', 'changing-theme')
    } else {
        document.documentElement.classList.remove('dark', 'changing-theme')
    }
    window.setTimeout(() => {
        document.documentElement.classList.remove('changing-theme')
    })
}

let settings = [
    {
        value: 'light',
        label: 'Light',
        icon: Sun,
    },
    {
        value: 'dark',
        label: 'Dark',
        icon: Moon,
    },
    {
        value: 'system',
        label: 'System',
        icon: Pc,
    },
]

function useTheme() {
    const [setting, setSetting] = useState('system')
    const initial = useRef(true)

    useIsomorphicLayoutEffect(() => {
        let theme = localStorage.theme
        if (theme === 'light' || theme === 'dark') {
            setSetting(theme)
        }
    }, [])

    useIsomorphicLayoutEffect(() => {
        if (setting === 'system') {
            localStorage.removeItem('theme')
        } else if (setting === 'light' || setting === 'dark') {
            localStorage.theme = setting
        }
        if (initial.current) {
            initial.current = false
        } else {
            update()
        }
    }, [setting])

    useEffect(() => {
        let mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

        if (mediaQuery?.addEventListener) {
            mediaQuery.addEventListener('change', update)
        } else {
            mediaQuery.addListener(update)
        }

        function onStorage() {
            update()
            let theme = localStorage.theme
            if (theme === 'light' || theme === 'dark') {
                setSetting(theme)
            } else {
                setSetting('system')
            }
        }
        window.addEventListener('storage', onStorage)

        return () => {
            if (mediaQuery?.removeEventListener) {
                mediaQuery.removeEventListener('change', update)
            } else {
                mediaQuery.removeListener(update)
            }

            window.removeEventListener('storage', onStorage)
        }
    }, [])

    return [setting, setSetting]
}

interface ThemeToggleProps {
    panelClassName?: string;
}

export function ThemeToggle({ panelClassName }: ThemeToggleProps) {
    let [setting, setSetting] = useTheme()

    const listboxOnChange = (value: string) => {
        if (typeof setSetting !== 'string')setSetting(value);
    };

    return (
        <Listbox as="div" className="relative" value={setting} onChange={listboxOnChange}>
            <Listbox.Label className="sr-only">Theme</Listbox.Label>
            <Listbox.Button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-heading">
                <span className="dark:hidden">
                    <Sun className="w-6 h-6" selected={setting !== 'system'} />
                </span>
                <span className="hidden dark:inline">
                    <Moon className="w-6 h-6" selected={setting !== 'system'} />
                </span>
            </Listbox.Button>
            <Listbox.Options
                className={`absolute z-50 top-full right-0 mt-2 w-36 overflow-hidden rounded-lg border border-line bg-card py-1 text-sm font-medium text-body shadow-lg ${panelClassName ?? ''}`}
            >
                {settings.map(({ value, label, icon: Icon }) => (
                    <Listbox.Option key={value} value={value} as={Fragment}>
                        {({ active, selected }) => (
                            <li className={`${selected ? 'text-accent' : ''} ${active ? 'bg-hover' : ''} py-1 px-2 flex items-center cursor-pointer`}>
                                <Icon selected={selected} className="w-6 h-6 mr-2" />
                                {label}
                            </li>
                        )}
                    </Listbox.Option>
                ))}
            </Listbox.Options>
        </Listbox>
    )
}