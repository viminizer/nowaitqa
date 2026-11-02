import { byId, open, tap } from './helpers/android.ts'
import type { Scenario } from './index.ts'

export default {
  id: 'views.checkbox',
  platforms: ['android'],
  async run(driver) {
    await open(driver, 'Views', 'Controls', '1. Light Theme')
    const checkbox = byId('io.appium.android.apis:id/check1')
    await tap(driver, checkbox)
    const checked = await driver.$(checkbox).getAttribute('checked')
    if (checked !== 'true') throw new Error('checkbox is not checked after a tap')
  },
} satisfies Scenario
