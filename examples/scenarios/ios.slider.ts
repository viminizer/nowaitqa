import type { Scenario } from '@nowait-qa/sdk'
import { open } from './helpers/ios.ts'

export default {
  id: 'ios.slider',
  platforms: ['ios'],
  async run(driver) {
    await open(driver, 'Sliders')
    const slider = driver.$('-ios class chain:**/XCUIElementTypeSlider[1]')
    await slider.waitForDisplayed()
    await slider.addValue('0.8') // a slider accepts a position; it cannot be cleared like text
    // XCTest moves the thumb by coordinates, so the percentage can round slightly differently
    // across simulator screen sizes.
    await driver.waitUntil(async () => {
      const value = Number.parseFloat((await slider.getAttribute('value')) ?? '')
      return Math.abs(value - 80) <= 2
    })
  },
} satisfies Scenario
