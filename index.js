var _ = require('lodash'),
  Promise = require('bluebird'),
  logger

function isPromiseAlike( obj ){
  return _.isObject(obj) && _.isFunction(obj.then) && _.isFunction(obj.catch)
}

var nodes = {}

function makeCollectionName( modelName, relationDef ){
  var ns = []
  if( !relationDef.isMaster ){
    ns = ns.concat([modelName,relationDef.name])
    if( relationDef.reverse){
      ns = ns.concat([relationDef.model,relationDef.reverse.name])
    }
  }else{
      ns = ns.concat([relationDef.model,relationDef.reverse.name,modelName,relationDef.name])
  }
  return ns.join('_')
}

function standardRelationModels( models){
  return models.map(function( m){
    if(_.isString( m)|| _.isNumber(m)){
      return {id: m}
    }else{
      return m
    }
  })
}


function generateAfterCreateCallback(modelName, relationDef, models) {
  var root = this
  return function handlerIndexAfterNodeCreate( newModel ) {
    if( !newModel[relationDef.name] ) return

    logger.log("detecting relation", relationDef.name)
    var relationModels = standardRelationModels([].concat(newModel[relationDef.name])),
      relationCollection = makeCollectionName(modelName, relationDef),
      bus = this

    //1. validate multiple
    if( !relationDef.multiple && relationModels.length !== 1) {
      return bus.error(406, 'relation not allow multiple for ' + relationDef.name + ' in ' + modelName)
    }

    if( relationDef.auth.indexOf( 'write') == -1 ){
      relationModels = _.filter(relationModels,"id")
    }


    return checkRelationMultiple.call(relationDef.reverse.multiple, relationCollection, relationDef.model, relationModels, models).then(function(){
      return createRelationModels.call(bus,  relationDef, relationModels, models).then(function( savedRelationModels ){
        return createRelationRecord.call(bus,relationCollection, relationDef, savedRelationModels, newModel,models).then(function(){
          return updateCaches.call( bus, relationDef, savedRelationModels, newModel, models).then(function(){
            return newModel[relationDef.name] = relationDef.multiple ? savedRelationModels : savedRelationModels.pop()
          })
        })
      })
    })


  }
}

function checkRelationMultiple( multiple, relationCollection, relationModelName, relationModels, models){
  //console.log("checkRelationMultiple")
  if( multiple ) return Promise.resolve()

  var bus = this
  return Promise.all(relationModels.map(function( relationModel){
    if( !relationModel.id ) return
    return models[relationCollection].findOne(_.zipObject([relationModelName],[relationModel.id])).then(function( record){
      if( record ) return Promise.reject( bus.error(406, relationModelName+" cannot have multiple relation"))
    })
  }))
}

function createRelationModels( relationDef, relationModels, models){
  //console.log( "createRelationModels",relationModels)
  return Promise.all( relationModels.map(function(relationModel){
    //console.log( relationModel, relationDef.model)
    if( relationModel.id ) return models[relationDef.model].findOne( relationModel.id)

    if( !relationDef.index ) return models[relationDef.model].create( relationModel)

    return models[relationDef.model].findOne(_.zipObject([relationDef.index],[relationModel[relationDef.index]])).then(function( foundRelationModel){
      return foundRelationModel ? foundRelationModel : models[relationDef.model].create( relationModel)
    })
  })).then(function( savedRelationModels){
    return _.filter(savedRelationModels, _.isObject)
  })
}

function createRelationRecord( relationCollection, relationDef, relationModels, modelIns, models){
  return Promise.all( relationModels.map(function( relationModel ){
    return models[relationCollection].find(  _.zipObject([relationDef.model, relationDef.reverse.model],[relationModel.id,modelIns.id])).then(function(record){
      console.log( "createRelationRecord",relationCollection,_.zipObject([relationDef.model, relationDef.reverse.model],[relationModel.id,modelIns.id]))
      if( record.length ) return record
      return models[relationCollection].create(  _.zipObject([relationDef.model, relationDef.reverse.model],[relationModel.id,modelIns.id]))
    })
  }))
}

function updateCaches(relationDef, relationModels, modelIns, models){
  var updateModelIns = _.pick( modelIns, [relationDef.name])
  if( relationDef.multiple ){
    updateModelIns[relationDef.name] = _.pluck(relationModels,"id")
  }else{
    updateModelIns[relationDef.name] = relationModels[0].id
  }
  //update cache to model
  //console.log( "updateCaches",relationModels,updateModelIns)

  return models[relationDef.reverse.model].update( {id: modelIns.id}, updateModelIns).then(function(){

    return Promise.all( relationModels.map(function( relationModel){
      var updateRelationModel = _.pick( relationModel,[relationDef.reverse.name])
      if( relationDef.reverse.multiple ) {

        updateRelationModel[relationDef.reverse.name] = _.uniq((relationModel[relationDef.reverse.name]||[]).concat(modelIns.id))
      }else{
        updateRelationModel[relationDef.reverse.name] = modelIns.id
      }
      //console.log( "updateCaches",relationDef.model,updateRelationModel)


      return models[relationDef.model].update( {id:relationModel.id}, updateRelationModel)
    }))
  })
}

function deleteRelationRecord(relationCollection, relationDef, savedRelationModels, updatedModel, models ){
  var bus = this

  return models[relationCollection].find(_.zipObject( [relationDef.reverse.model], [updatedModel.id])).then( function(relationRecords){
    //console.log("deleteRelationRecord",relationCollection,_.zipObject( [relationDef.reverse.model], [updatedModel.id]), relationRecords)

    var savedRelationModelIds = _.pluck( savedRelationModels, "id"),
      needDeleteRelations = relationRecords.filter( function( relationRecord){ return savedRelationModelIds.indexOf( relationRecord[relationDef.model] )})

    //console.log("deleteRelationRecord",relationRecords,savedRelationModelIds,needDeleteRelations)
    return Promise.all( needDeleteRelations.map(function( needDeleteRelation){
      return models[relationCollection].destroy({id:needDeleteRelation.id}).then(function(){
        return models[relationDef.model].findOne(needDeleteRelation[relationDef.model]).then(function( relationModel){
          if( !relationModel ) return console.log( relationDef.model,needDeleteRelation[relationDef.model],"not exist")
          var updateRelationModel  = _.pick(relationModel,['id',relationDef.reverse.name])

          if( relationDef.reverse.multiple ){
            updateRelationModel[relationDef.reverse.name] = _.without([].concat(updateRelationModel[relationDef.reverse.name]) ,updatedModel.id)
          }else if( updateRelationModel[relationDef.reverse.name] == updatedModel.id ){
            updateRelationModel[relationDef.reverse.name] = null
          }
          //console.log("delete relation field in relation model", relationDef.model,updateRelationModel)
          return models[relationDef.model].update( {id:relationModel.id}, updateRelationModel )
        })
      })
    }))
  })
}

function generateAfterUpdateCallback(modelName, relationDef, models) {
  var root = this
  return function handlerRelationAfterModelUpdate( updatedModels, criteria, updateObj ) {
    var bus = this
    if( !updateObj[relationDef.name] || updatedModels.length ==0 ) return
    if( updatedModels.length >1 && updateObj[relationDef.name]) return bus.error(406, "can not update relation of multiple record")

    logger.log("updating relation", relationDef.name)

    var relationModels = standardRelationModels([].concat(updateObj[relationDef.name])),
      updatedModel = updatedModels[0],
      relationCollection = makeCollectionName(modelName, relationDef)

    //1. validate multiple
    if( !relationDef.multiple && _.isArray( relationModels )) {
      return bus.error(406, 'relation not allow multiple for ' + relationDef.name + ' in ' + modelName)
    }

    if( relationDef.auth.indexOf( 'write') == -1 ){
      relationModels = _.filter(relationModels,"id")
    }

    return checkRelationMultiple.call(relationDef.reverse.multiple, relationCollection, relationDef.model, relationModels, models).then(function(){
      return createRelationModels.call(bus,  relationDef, relationModels,models).then(function( savedRelationModels ){
        return createRelationRecord.call(bus,relationCollection, relationDef, savedRelationModels, updatedModel, models).then(function(){
          return deleteRelationRecord.call( bus,relationCollection, relationDef, savedRelationModels, updatedModel,models).then(function(){
            return updateCaches.call( bus, relationDef, savedRelationModels, updatedModel,models).then(function(){
              return updatedModel[relationDef.name] = relationDef.multiple ? savedRelationModels : savedRelationModels.pop()
            })
          })
        })
      })
    })
  }
}


function generateBeforeModelFindHandler( modelName, relationDef, models){
  var relationCollection = makeCollectionName(modelName,relationDef)

  return {
    "function": function replaceRelationQueryWithIds( criteria ){
      //TODO change find criteria
      if( !criteria[relationDef.name] ) return

      var bus = this

      var replacePromise = models[relationDef.model].find(criteria[relationDef.name]).then(function( relationModels ){
        var relationIds = _.pluck( relationModels,"id")
        if( !relationIds.length) return bus.error(404,"model not found with relations")

        return models[relationCollection].find(_.zipObject([relationDef.model],relationIds)).then(function( relations){
          var modelIds = _.pluck( relations, modelName )
          if( criteria.id ){
            if(modelIds.indexof( criteria.id) == -1) return bus.error(404,"model not found with relations")
          }else{
            criteria.id = modelIds
          }
        })
      })

      replacePromise.block = true
      return replacePromise
    },
    "name" : "replaceRelation"+relationDef.name.replace(/^(\w)/,function(r){ return r.toUpperCase()})+"QueryWithIds",
    "first" : true
  }
}

function generateAfterModelFindHandler(modelName, relationDef,models){
  var relationCollection = makeCollectionName(modelName,relationDef)
  return {
    "function" : function fetchRelationObjects( records, criteria ){
      var bus = this

      if( !criteria.populate || criteria.populate.split(",").indexOf(relationDef.name) ==-1) return

      var ids = _.flatten(_.pluck( (_.isArray(records) ? records : [records]), "id" ))
      return bus.fire(relationCollection+".find", _.zipObject([modelName],[ids])).then(function( relationEventResults ){
        var relations = relationEventResults['model.find.'+relationCollection]
        var relationIds = _.pluck( relations, relationDef.model )

        return bus.fire(relationDef.model+".find",{id:relationIds}).then(function( relationModelResults){
          var relationModels = _.indexBy( relationModelResults['model.find.'+relationDef.model], "id")

          var relationIndexes = _.groupBy( relations, modelName )
          //console.log("found relation models", relationModels, relationIndexes)
          _.forEach((_.isArray(records) ? records : [records]), function(record){
            if( !relationIndexes[record.id] ) return

            if(relationDef.multiple ){
              record[relationDef.name] = relationIndexes[record.id].map(function( relation ){
                return relationModels[relation[relationDef.model]]
              })
            }else{
              //console.log( relationIndexes[record.id].pop() )
              var theRelation = relationIndexes[record.id].pop()
              if( theRelation  ){
                record[relationDef.name] = relationModels[theRelation[relationDef.model]]
              }
            }
          })
        })
      })
    },
    "name" : "fetchRelation" + relationDef.name.replace(/^\w/,function(r){return r.toUpperCase()})


  }
}


var relationModule = {
  indexes : {},
  listen : {},
  models : {},
  config : {
    connection : 'localDisk'
  },
  init : function(){
    logger = this.dep.logger
  },
  expand : function( module ){
    var root = this
    if( module.models ){
      module.models.forEach(function( model ){
        if( model.relations ){
          _.forEach(model.relations, function( relationDef, attrName){
            relationDef = _.defaults(relationDef,{
              //model : relation must have model
              name :attrName,
              auth : ['read'],
              multiple : false,
              isMaster : true
            })

            root.indexes[model.identity] = (root.indexes[model.identity] || []).concat(relationDef)

            if( relationDef.reverse ){
              relationDef.reverse = _.defaults(relationDef.reverse,{
                model : model.identity,
                //name : reverse must have a name
                auth : ['read'],
                reverse : _.cloneDeep(_.omit( relationDef,"reverse")),
                multiple : false
              })
              var reverseRelationDef = _.cloneDeep( relationDef.reverse )
              root.indexes[relationDef.model] = (root.indexes[relationDef.model]||[]).concat(reverseRelationDef)
            }

            var relationCollection = makeCollectionName(model.identity, relationDef)
            if( !root.models[relationCollection]){
              root.models[relationCollection] = {
                identity : relationCollection,
                attributes : {},
                connection : root.config.connection,
                rest : true
              }
            }
          })
        }
      })
    }
  },
  bootstrap : {
    "function": function () {
      var root = relationModule,
        models = root.dep.model.models

      root.dep.model.expand(root)

      _.forEach(root.indexes, function (relationDefs, modelName) {
        _.forEach(relationDefs, function (relationDef) {

          root.dep.bus.on(modelName + '.create.after', generateAfterCreateCallback.call(root,modelName, relationDef, models))
          root.dep.bus.on(modelName + '.update.after',generateAfterUpdateCallback.call(root,modelName,relationDef, models ))
          root.dep.bus.on(modelName + '.find', generateBeforeModelFindHandler.call(root,modelName, relationDef, models))
          root.dep.bus.on(modelName + '.find.after', generateAfterModelFindHandler.call(root,modelName, relationDef, models))
          root.dep.bus.on(modelName + '.findOne.after', generateAfterModelFindHandler.call(root,modelName, relationDef, models))
        })
      })
    },
    "order" : {"before":"model.bootstrap"}
  }
}

module.exports = relationModule

