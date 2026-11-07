import React from 'react'
import { IndexPageTemplate } from '../../templates/index-page-template'

const IndexPagePreview = ({ entry }: any) => {
  const data = entry.getIn(['data']).toJS()

  if (data) {
    return (
      <IndexPageTemplate
        title={data.title}
        subheading={data.subheading}
        articles={[]}
      />
    )
  } else {
    return <div>Loading...</div>
  }
}

export default IndexPagePreview
