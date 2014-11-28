# zero-relation #

This module use middle-collection to make relation between to models.

## Usage ##

1. Add dependency to your module package.json file like:

```
{
	"name" : "YOUR_MODULE_NAME",
	"zero" : {
		"dependencies" : {
			"relation" : "^0.0.1"
		}
	}
}
```

2. Declare `relation` in model definition like:

```
module.modes = [
{
  identity: 'post',
  attributes: {
    title : 'string',
    content : 'string',
    category : 'array'
  },
  isNode : true,
  rest : true
},{
  identity : 'tag',
  attributes : {
    name : {
      type : 'string',
      unique : true
    },
    nodes : 'json'
  },
  relations : {
    posts :{
      model : "post",
      auth : ['read'],
      multiple : true,
      reverse : {
        name : "tags",
        index:"name",
        auth : ['read','write'],
        multiple : true
      }
    }
  },
  index : 'name',
  rest : true
}
]
```

Once you declared the relation between two model, this module will handler all relation creation of modification for you.
For example above, if you create a post with parameter like:

```
{
	title : 'test',
	content : 'test',
	tags : [{name:'tag1'}, 2]
}
```

Relation module will create a new tag named `tag1`, and update tag's relation which id is 2.

3. You can use `populate` to specify which relation record you want to fetch with current request. For example, you can fetch a post which id is 1 with all its tags using:

```
http://localhost/post/1?populate=tags
```
