import type { Scenario } from '@nowait-qa/sdk'
import { open } from './helpers/ios.ts'

export default {
  id: 'ios.switch',
  platforms: ['ios'],
  async run(driver) {
    await open(driver, 'Switches')
    const toggle = driver.$('-ios class chain:**/XCUIElementTypeSwitch[1]')
    await toggle.waitForDisplayed()
    const before = await toggle.getAttribute('value')
    await toggle.click()
    await driver.waitUntil(async () => (await toggle.getAttribute('value')) !== before)
  },
} satisfies Scenario
