import React from 'react'
import { BlogPostTemplate } from '../../templates/blog-post-template'

const BlogPostPreview = ({ entry, widgetFor }: any) => {
  const tags = entry.getIn(['data', 'tags'])
  return (
    <BlogPostTemplate
      content={widgetFor('body')}
      description={entry.getIn(['data', 'description'])}
      tags={tags && tags.toJS()}
      title={entry.getIn(['data', 'title'])}
      slug={entry.get('slug') ?? ''}
      // No comment thread in the editor: Disqus would load into the CMS itself.
      comments={false}
    />
  )
}

export default BlogPostPreview
