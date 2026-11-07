import React from 'react'
import { AboutPageTemplate } from '../../templates/about-page-template'

const AboutPagePreview = ({ entry, widgetFor, getAsset }: any) => (
  <AboutPageTemplate
    title={entry.getIn(['data', 'title'])}
    aboutimage={getAsset(entry.getIn(['data', 'aboutimage']))}
    content={widgetFor('body')}
  />
)

export default AboutPagePreview
